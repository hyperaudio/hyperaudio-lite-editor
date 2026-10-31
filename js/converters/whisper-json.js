/**
 * converters/whisper-json.js
 * (C) The Hyperaudio Project
 * @version 1.3.43 — last changed in release 1.3.43
 * @license MIT
 *
 * A Whisper JSON file (#631, #751) as the editor's canonical transcript. The
 * import dialog (js/whisper-json-import.js) reads the file and puts the
 * result on the page. Nothing here touches the page.
 *
 * Whisper's JSON is what people have lying around, and it comes in five
 * dialects that differ enough to need sniffing. Every one of them is
 * normalised to the editor's canonical { words, paragraphs }, so nothing
 * here builds transcript markup by hand:
 *
 *   segments[]      Whisper CLI, faster-whisper, OpenAI verbose_json —
 *                   word timings in segments[].words[] when the run asked for
 *                   them, segment-level otherwise
 *   words[]         OpenAI verbose_json with word granularity, top level
 *   transcription[] whisper.cpp -oj, offsets in MILLISECONDS
 *   segments[] +    WhisperX, which also carries diarization speakers
 *     speaker
 *   chunks[]        transformers.js / a Hugging Face pipeline, which is what
 *                   the editor's own local Whisper produces (its live output
 *                   goes through converters/whisper.js, with the engine's own
 *                   rules)
 *
 * The awkward parts are the same in all of them: the space belongs to the
 * front of the word, a model emits non-speech as its own bracketed token, and
 * a word can arrive with no timing at all (WhisperX drops the ones its
 * aligner could not place; the last chunk often has no end).
 */
(function (root) {
  'use strict';

  const shared = (root && root.HyperaudioConverters) || (typeof require === 'function' ? require('./transcript-words.js') : null);

  const NOMINAL_WORD_SECONDS = 0.3;

  // A token that is wholly bracketed is never speech: [BLANK_AUDIO], [Music],
  // (applause), ♪. A bracket INSIDE a word is left alone.
  const NON_SPEECH = /^[[(♪][^\])♪]*[\])♪]?$/;

  // Contiguous vowel groups — the heuristic the editor's own word-split uses.
  // When this runs in the page the editor's copy is preferred, so a split and
  // an import can never disagree about where a long word's time goes.
  const localSyllables = (token) => {
    const groups = String(token).toLowerCase().match(/[aeiouyàáâäãèéêëìíîïòóôöõùúûüýÿ]+/g);
    return Math.max(1, groups ? groups.length : 1);
  };
  const syllablesIn = (token) => (root && typeof root.estimateSyllables === 'function'
    ? root.estimateSyllables(token)
    : localSyllables(token));

  const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

  /**
   * Which dialect a parsed JSON document is, or null when it is none of them.
   * Order matters: WhisperX is segments[] too, and is told apart by carrying
   * speakers.
   */
  function detectDialect(json) {
    if (json === null || typeof json !== 'object') return null;
    if (Array.isArray(json.chunks)) return 'transformers';
    if (Array.isArray(json.transcription)) return 'whisper.cpp';
    if (Array.isArray(json.segments)) {
      const diarized = json.segments.some((s) => s && (s.speaker !== undefined
        || (Array.isArray(s.words) && s.words.some((w) => w && w.speaker !== undefined))));
      return diarized ? 'whisperx' : 'whisper';
    }
    if (Array.isArray(json.words)) return 'openai-words';
    return null;
  }

  // Split a stretch of text into words carrying the share of [start, end]
  // their syllables earn. Used where a dialect gives segment timings only.
  function distribute(text, start, end, speaker) {
    const tokens = String(text).trim().split(/\s+/).filter((t) => t.length > 0 && !NON_SPEECH.test(t));
    if (tokens.length === 0) return [];
    const span = Math.max(0, end - start);
    const weights = tokens.map(syllablesIn);
    const total = weights.reduce((a, b) => a + b, 0);
    let cursor = start;
    return tokens.map((text_, i) => {
      // the last word absorbs the rounding remainder, keeping the run flush
      const share = i === tokens.length - 1 ? (start + span) - cursor : span * (weights[i] / total);
      const word = { text: text_, start: cursor, end: cursor + share };
      if (speaker) word.speaker = speaker;
      cursor = word.end;
      return word;
    });
  }

  // Words whose times a dialect left out: fill each run from the last known
  // end to the next known start, by the same syllable weighting. A run at
  // either edge of the transcript runs on at a nominal pace.
  function fillMissingTimes(words) {
    let i = 0;
    while (i < words.length) {
      if (isFiniteNumber(words[i].start) && isFiniteNumber(words[i].end)) { i += 1; continue; }
      let j = i;
      while (j < words.length && !(isFiniteNumber(words[j].start) && isFiniteNumber(words[j].end))) j += 1;
      const run = words.slice(i, j);
      const before = i > 0 ? words[i - 1].end : null;
      const after = j < words.length ? words[j].start : null;
      let from;
      let to;
      if (isFiniteNumber(before) && isFiniteNumber(after)) {
        from = before;
        to = Math.max(before, after);
      } else if (isFiniteNumber(after)) {
        to = after;
        from = Math.max(0, after - run.length * NOMINAL_WORD_SECONDS);
      } else if (isFiniteNumber(before)) {
        from = before;
        to = before + run.length * NOMINAL_WORD_SECONDS;
      } else {
        from = 0;
        to = run.length * NOMINAL_WORD_SECONDS;
      }
      const spread = distribute(run.map((w) => w.text).join(' '), from, to);
      run.forEach((w, k) => {
        if (spread[k] === undefined) return;
        w.start = spread[k].start;
        w.end = spread[k].end;
      });
      i = j;
    }
    return words;
  }

  // One word from a dialect's word entry. `word` (Whisper, WhisperX) or
  // `text` (transformers) — the leading space is the model's, not ours.
  function wordFrom(entry, speaker) {
    const raw = entry.word !== undefined ? entry.word : entry.text;
    const text = String(raw === undefined || raw === null ? '' : raw).trim();
    if (text === '' || NON_SPEECH.test(text)) return null;
    const timestamp = Array.isArray(entry.timestamp) ? entry.timestamp : null;
    const start = timestamp !== null ? timestamp[0] : entry.start;
    const end = timestamp !== null ? timestamp[1] : entry.end;
    const word = {
      text,
      start: isFiniteNumber(start) ? start : null,
      end: isFiniteNumber(end) ? end : null,
      // no leading space means this word is glued to the one before it, which
      // is how "speech-to-text" survives as one word (#347)
      glued: typeof raw === 'string' && raw.length > 0 && !/^\s/.test(raw),
    };
    const who = entry.speaker !== undefined ? entry.speaker : speaker;
    if (who) word.speaker = String(who);
    return word;
  }

  function wordsFromSegments(segments) {
    const out = [];
    segments.forEach((segment) => {
      if (segment === null || typeof segment !== 'object') return;
      const speaker = segment.speaker !== undefined && segment.speaker !== null
        ? String(segment.speaker) : null;
      if (Array.isArray(segment.words) && segment.words.length > 0) {
        segment.words.forEach((entry) => {
          const word = wordFrom(entry, speaker);
          if (word !== null) out.push(word);
        });
        return;
      }
      // segment timings only: share them out across the segment's words
      const start = isFiniteNumber(segment.start) ? segment.start : null;
      const end = isFiniteNumber(segment.end) ? segment.end : null;
      if (start === null || end === null) {
        String(segment.text || '').trim().split(/\s+/).filter((t) => t.length > 0 && !NON_SPEECH.test(t))
          .forEach((text) => {
            const word = { text, start: null, end: null, glued: false };
            if (speaker) word.speaker = speaker;
            out.push(word);
          });
        return;
      }
      distribute(segment.text, start, end, speaker).forEach((w) => out.push({ ...w, glued: false }));
    });
    return out;
  }

  /**
   * A Whisper JSON document of any supported dialect, as the editor's
   * canonical transcript.
   *
   * @param {object} json - the parsed file.
   * @returns {{words: Array, paragraphs: Array, language: (string|null), dialect: string}}
   */
  function whisperJson(json) {
    const dialect = detectDialect(json);
    if (dialect === null) {
      throw new Error('This does not look like Whisper JSON (no segments, words, chunks or transcription).');
    }

    let words;
    if (dialect === 'transformers') {
      words = json.chunks.map((c) => wordFrom(c, null)).filter((w) => w !== null);
    } else if (dialect === 'whisper.cpp') {
      words = wordsFromSegments(json.transcription.map((entry) => ({
        // offsets are milliseconds here, and the only timings on offer
        start: entry && entry.offsets && isFiniteNumber(entry.offsets.from) ? entry.offsets.from / 1000 : null,
        end: entry && entry.offsets && isFiniteNumber(entry.offsets.to) ? entry.offsets.to / 1000 : null,
        text: entry ? entry.text : '',
      })));
    } else if (dialect === 'openai-words') {
      words = json.words.map((w) => wordFrom(w, null)).filter((w) => w !== null);
    } else {
      words = wordsFromSegments(json.segments);
    }

    if (words.length === 0) throw new Error('That Whisper JSON has no words in it.');
    fillMissingTimes(words);

    // The editor marks the word BEFORE a glued one, so a token that arrived
    // with no leading space closes up the gap behind it.
    const out = words.map((w, i) => {
      const word = { start: w.start, end: w.end, text: w.text };
      if (i + 1 < words.length && words[i + 1].glued) word.space = false;
      return word;
    });

    const language = typeof json.language === 'string' ? json.language
      : (json.params && typeof json.params.language === 'string' ? json.params.language : null);

    // the paragraphs are placed over the words with their speakers, which the
    // transcript's own words do not carry (#631)
    return { words: out, paragraphs: shared.paragraphsFrom(words), language, dialect };
  }

  const api = { whisperJson, detectDialect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.HyperaudioConverters = root.HyperaudioConverters || {};
    Object.assign(root.HyperaudioConverters, api);
  }
}(typeof window !== 'undefined' ? window : null));

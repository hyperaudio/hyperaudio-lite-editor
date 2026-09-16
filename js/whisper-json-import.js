/*! (C) The Hyperaudio Project. AGPL 3.0 @license: https://www.gnu.org/licenses/agpl-3.0.en.html */
/*! Hyperaudio Lite Editor - Whisper JSON import. @version 1.3.17 — last changed in release 1.3.17 */

// Self-contained, modular import feature (#631). To remove it entirely:
// delete this file, its <script> tag in index.html, and the
// <import-whisper-json> menu item and element mount.
//
// Whisper's JSON is what people have lying around, and it comes in five
// dialects that differ enough to need sniffing. Every one of them is
// normalised to the editor's canonical { words, paragraphs } and handed to
// jsonToHTML, so nothing here builds transcript markup by hand:
//
//   segments[]      Whisper CLI, faster-whisper, OpenAI verbose_json —
//                   word timings in segments[].words[] when the run asked for
//                   them, segment-level otherwise
//   words[]         OpenAI verbose_json with word granularity, top level
//   transcription[] whisper.cpp -oj, offsets in MILLISECONDS
//   segments[] +    WhisperX, which also carries diarization speakers
//     speaker
//   chunks[]        transformers.js / a Hugging Face pipeline, which is what
//                   the editor's own local Whisper produces
//
// The awkward parts are the same in all of them: the space belongs to the
// front of the word, a model emits non-speech as its own bracketed token, and
// a word can arrive with no timing at all (WhisperX drops the ones its
// aligner could not place; the last chunk often has no end).

(function () {
  'use strict';

  const MAX_WORDS_IN_PARAGRAPH = 100;
  const SIGNIFICANT_GAP_SECONDS = 4.0;
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
  const syllablesIn = (token) => (typeof estimateSyllables === 'function'
    ? estimateSyllables(token)
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

  // Paragraphs where a reader would want them: a change of speaker always, a
  // long gap, or simply length — the same rule the Deepgram import uses.
  function paragraphsFrom(words) {
    const paragraphs = [];
    let current = null;
    let count = 0;
    words.forEach((word, index) => {
      const previous = index > 0 ? words[index - 1] : null;
      const speakerChanged = previous !== null && (word.speaker || null) !== (previous.speaker || null);
      const gap = previous !== null ? word.start - previous.end : 0;
      const tooLong = count >= MAX_WORDS_IN_PARAGRAPH;
      const endsSentence = previous !== null && /[.?!]["')\]]?$/.test(previous.text);
      const shouldBreak = current === null || speakerChanged
        || (gap > SIGNIFICANT_GAP_SECONDS && endsSentence) || (tooLong && endsSentence);
      if (shouldBreak) {
        current = { start: word.start, end: word.end };
        if (word.speaker) current.speaker = word.speaker;
        paragraphs.push(current);
        count = 0;
      }
      current.end = word.end;
      count += 1;
    });
    return paragraphs;
  }

  /**
   * A Whisper JSON document of any supported dialect, as the editor's
   * canonical transcript.
   *
   * @param {object} json - the parsed file.
   * @returns {{words: Array, paragraphs: Array, language: (string|null), dialect: string}}
   */
  function whisperJsonToTranscript(json) {
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

    return { words: out, paragraphs: paragraphsFrom(words), language, dialect };
  }

  /* ---- The menu item and its dialog ------------------------------------- */

  const byId = (id) => document.getElementById(id);

  function ensureDialog() {
    if (byId('file-import-whisper-json-dialog') !== null) return;
    const holder = document.createElement('div');
    holder.innerHTML =
      '<input type="checkbox" id="file-import-whisper-json-dialog" class="modal-toggle" tabindex="-1" aria-hidden="true" />'
      + '<div class="modal"><div class="modal-box relative">'
      + '<label for="file-import-whisper-json-dialog" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">✕</label>'
      + '<h3 class="font-bold text-lg">Import Whisper JSON</h3>'
      + '<p style="margin-top:8px; font-size:0.9rem; opacity:0.75">From the Whisper command line, the OpenAI API, whisper.cpp, WhisperX or a Hugging Face pipeline. Word timings are used where the file has them; otherwise each segment’s words are spread across it.</p>'
      + '<div class="flex flex-col gap-4 w-full" style="margin-top:16px">'
      + '<input id="whisper-json-media" type="text" placeholder="Link to media" class="input input-bordered w-full max-w-xs" />'
      + '<label class="label-text" for="whisper-json-file">or use local media file</label>'
      + '<input id="whisper-json-file" name="whisper-json-file" type="file" class="file-input w-full max-w-xs" title="" />'
      + '<label class="label-text" for="whisper-json">select local JSON file</label>'
      + '<input id="whisper-json" name="whisper-json" type="file" accept="application/json,.json" class="file-input w-full max-w-xs" title="" />'
      + '<p id="whisper-json-status" role="status" aria-live="polite" style="min-height:1.4em; font-size:0.9rem; margin:0"></p>'
      + '</div>'
      + '<div class="modal-action">'
      + '<label for="file-import-whisper-json-dialog" class="btn btn-ghost">Cancel</label>'
      + '<button type="button" id="file-import-whisper-json" class="btn btn-primary">Import</button>'
      + '</div>'
      + '</div></div>';
    document.body.appendChild(holder);

    const mediaUrl = byId('whisper-json-media');
    const mediaFile = byId('whisper-json-file');
    const jsonFile = byId('whisper-json');
    const status = byId('whisper-json-status');

    // one media source or the other, as the other import dialogs do
    mediaUrl.addEventListener('input', () => { mediaFile.disabled = mediaUrl.value.trim() !== ''; });
    mediaFile.addEventListener('change', () => { mediaUrl.disabled = mediaFile.files.length > 0; });

    byId('file-import-whisper-json').addEventListener('click', async () => {
      status.style.color = '';
      const file = jsonFile.files && jsonFile.files[0];
      if (!file) { status.textContent = 'Choose a Whisper JSON file first.'; return; }
      const transcript = byId('hypertranscript');
      if (transcript === null || typeof jsonToHTML !== 'function') {
        status.textContent = 'You can only import into the transcript view.';
        return;
      }
      let result;
      try {
        result = whisperJsonToTranscript(JSON.parse(await file.text()));
      } catch (e) {
        status.style.color = 'oklch(var(--er))';
        status.textContent = e instanceof SyntaxError ? 'That file is not valid JSON.' : e.message;
        return;
      }

      const player = document.querySelector('#hyperplayer');
      if (player !== null) {
        if (mediaFile.files && mediaFile.files[0]) player.src = URL.createObjectURL(mediaFile.files[0]);
        else if (mediaUrl.value.trim() !== '') player.src = mediaUrl.value.trim();
      }

      const track = document.querySelector('#hyperplayer-vtt');
      if (track !== null && result.language) {
        // setAttribute, not the IDL property: the attribute is `srclang`, all
        // lower case, so `track.srcLang = …` sets an expando and nothing else
        track.setAttribute('label', result.language);
        track.setAttribute('srclang', result.language);
      }

      // the same door the other imports use
      if (typeof window.clearPendingTranscription === 'function') window.clearPendingTranscription();
      transcript.innerHTML = jsonToHTML({ words: result.words, paragraphs: result.paragraphs });
      document.dispatchEvent(new CustomEvent('hyperaudioInit'));
      status.textContent = '';
      byId('file-import-whisper-json-dialog').checked = false;
    });
  }

  // The element is declared only in a browser: `extends HTMLElement` is
  // evaluated at load, and the parser above is required by the unit tests in
  // node, where there is no such class.
  if (typeof customElements !== 'undefined' && typeof HTMLElement !== 'undefined') {
    customElements.define('import-whisper-json', class extends HTMLElement {
      connectedCallback() {
        ensureDialog();
        this.innerHTML = '<label for="file-import-whisper-json-dialog">Whisper JSON</label>';
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.WhisperJsonImport = Object.freeze({ whisperJsonToTranscript, detectDialect });
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { whisperJsonToTranscript, detectDialect };
  }
})();

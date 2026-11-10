/**
 * converters/transcript-words.js
 * (C) The Hyperaudio Project
 * @version 1.3.46 — last changed in release 1.3.46
 * @license AGPL-3.0-only
 *
 * The converters (#751). Each file in this folder turns one source's own
 * output into the editor's canonical transcript, `{ words, paragraphs }`:
 * words as `{ text, start, end, speaker? }` with times in seconds, and the
 * paragraphs placed by the one rule every engine and import share
 * (js/paragraph-rule.js, #743). jsonToHTML (js/html-json-converter.js) then
 * renders that as the transcript's markup, so no converter builds markup of
 * its own. A converter is a pure function: no DOM, no network, nothing read
 * from the page, so each runs in node against a fixture of its source's real
 * output (__TEST__/unit/converters).
 *
 * The engine's client keeps the connecting: uploading the file or sending
 * the link, polling, the worker, the progress and the dialog. When the
 * result arrives it hands it to the converter, and puts what comes back on
 * the page.
 *
 * This file is what they share: the paragraphs of a word list, and the
 * transcript built from one. Each converter registers itself on
 * window.HyperaudioConverters in the page, and exports itself in node.
 */
(function (root) {
  'use strict';

  // the rule, from the page or from the file beside this one in node
  const paragraphRule = () => {
    if (root && typeof root.hyperaudioParagraphStarts === 'function') return root.hyperaudioParagraphStarts;
    if (typeof require === 'function') {
      try { return require('../paragraph-rule.js').paragraphStarts; } catch (e) { return null; }
    }
    return null;
  };

  // Paragraphs where the rule puts them: each runs from its first word's
  // start to its last word's end, and carries its words' speaker, which is
  // the label jsonToHTML writes at its head (the rule breaks on every change
  // of speaker, so a paragraph never has two). Without the rule, one
  // paragraph.
  function paragraphsFrom(words) {
    const rule = paragraphRule();
    const starts = rule !== null ? rule(words) : new Set();
    const paragraphs = [];
    let current = null;
    words.forEach((word, index) => {
      if (current === null || starts.has(index)) {
        current = { start: word.start, end: word.end };
        if (word.speaker) current.speaker = word.speaker;
        paragraphs.push(current);
      }
      current.end = word.end;
    });
    return paragraphs;
  }

  // A word with no duration. Qwen3-ASR through the Hugging Face route times
  // a seventh of its words as a single instant. A sentence-final word gets
  // the instant the next word begins at: "doing." at 172.30–172.30 and "And"
  // from 172.30. jsonToHTML places words in paragraphs by time and a tie goes
  // to the later paragraph, so when the rule broke after "doing." that word
  // opened the next paragraph and the sentence read "interested in / doing.
  // And I was". A sentence-initial word gets the instant it began at, after
  // the pause: "Wow!" at 85.68–85.68 with the next word later.
  //
  // Several words in a row can share one instant, so a run is handled as one.
  // A run that ENDED at its instant — the next word starts there, or the run
  // ends a sentence the word before it did not — reaches back, up to 0.3 s a
  // word and never past the previous word's end. Any other run began at its
  // instant and reaches forward, up to 0.25 s a word and never past the next
  // word's start, which keeps the pause BEFORE a sentence-initial word where
  // the paragraph rule reads it. The words of a run share the reach equally.
  // With no room either way the run takes a sliver back into the previous
  // word, so that it always starts before the word after it. Words with a
  // duration are untouched.
  const BACK_SECONDS = 0.3;
  const FORWARD_SECONDS = 0.25;
  const endsSentence = (text) => /[.?!]$/.test(String(text === undefined || text === null ? '' : text));
  const timed = (word) => typeof word.start === 'number' && typeof word.end === 'number';
  function withDurations(words) {
    const out = words.slice();
    let i = 0;
    while (i < out.length) {
      const word = out[i];
      if (!timed(word) || word.end > word.start) { i += 1; continue; }
      const at = word.start;
      let j = i;
      while (j + 1 < out.length && timed(out[j + 1]) && out[j + 1].end <= out[j + 1].start && out[j + 1].start === at) j += 1;
      const count = j - i + 1;
      const prev = i > 0 ? out[i - 1] : null;
      const next = j + 1 < out.length ? out[j + 1] : null;
      const prevEnd = prev !== null && timed(prev) ? prev.end : null;
      const nextStart = next !== null && timed(next) ? next.start : null;
      // a run after a sentence end BEGAN here, whatever the next word's time
      // says: "that. | Actually, just" with "just" timed from the same
      // instant. Forward, so the pause before it is left whole for the rule.
      const beganHere = prev !== null && endsSentence(prev.text);
      const endedHere = !beganHere && ((nextStart !== null && nextStart <= at) || endsSentence(out[j].text));
      let from;
      let to;
      if (endedHere && (prevEnd === null || prevEnd < at)) {
        from = Math.max(prevEnd === null ? at - BACK_SECONDS * count : prevEnd, at - BACK_SECONDS * count);
        to = at;
      } else if (nextStart === null || nextStart > at) {
        from = at;
        to = Math.min(nextStart === null ? at + FORWARD_SECONDS * count : nextStart, at + FORWARD_SECONDS * count);
      } else if (beganHere) {
        // the next word is timed from the same instant: a sliver over it,
        // and the tie in time goes to the paragraph this word opens
        from = at;
        to = at + 0.05 * count;
      } else if (prev !== null && prevEnd !== null) {
        from = Math.max(typeof prev.start === 'number' ? prev.start : prevEnd - 0.001 * count, prevEnd - 0.001 * count);
        to = prevEnd;
      } else {
        from = at;
        to = at + FORWARD_SECONDS * count;
      }
      const step = (to - from) / count;
      for (let k = 0; k < count; k += 1) {
        out[i + k] = Object.assign({}, out[i + k], { start: from + step * k, end: k === count - 1 ? to : from + step * (k + 1) });
      }
      i = j + 1;
    }
    return out;
  }

  // The canonical transcript of a word list. The words go through as they
  // are — seconds, text, speaker, and `space: false` on a word glued to the
  // one after it — except that a word with no duration is given one, above.
  //
  // jsonToHTML writes a speaker label at the head of every paragraph that
  // names one. The engines that diarize always labelled a speaker once, at
  // their first word and at each change, and not again when the same
  // speaker's paragraph broke on a pause or on length: `labelOnChange` keeps
  // that, by leaving the speaker off a paragraph that follows one of the
  // same speaker's. The words keep theirs either way.

  function transcriptFromWords(list, options) {
    const words = withDurations(Array.isArray(list) ? list : []);
    const paragraphs = paragraphsFrom(words);
    if (options && options.labelOnChange === true) {
      let previous = null;
      paragraphs.forEach((paragraph) => {
        const speaker = paragraph.speaker === undefined ? null : paragraph.speaker;
        if (speaker !== null && speaker === previous) delete paragraph.speaker;
        previous = speaker;
      });
    }
    return { words, paragraphs };
  }

  // ... and its markup, by the one renderer
  const renderer = () => {
    if (root && typeof root.jsonToHTML === 'function') return root.jsonToHTML;
    if (typeof require === 'function') {
      try { return require('../html-json-converter.js').jsonToHTML; } catch (e) { return null; }
    }
    return null;
  };
  function transcriptToHtml(transcript) {
    const render = renderer();
    if (render === null) throw new Error('jsonToHTML is not loaded');
    return render({ words: transcript.words, paragraphs: transcript.paragraphs });
  }

  // Timing a transcript cannot have had (#786). Nemotron's word times come from an
  // alignment of its finished text onto the audio, and on a long recording
  // that alignment has slipped: a passage of speech stamped into a few
  // seconds, at ten words a second and more, beside a stretch of speech with
  // no words at all (an 18-minute debate, three such stretches, in different
  // places on each run). The text is right and the times are not, and
  // nothing here can put them right. Nobody speaks twelve words in a second
  // and a half: the fastest healthy transcript among the fixtures runs at
  // five words a second over twelve words. So any SQUEEZED_WORDS consecutive
  // words inside SQUEEZED_WORDS / SQUEEZED_RATE seconds mark a stretch whose
  // timing cannot be trusted. Runs within SQUEEZED_MERGE_SECONDS of each
  // other are one stretch, and a stretch of fewer than SQUEEZED_MIN_WORDS
  // words is left alone: two people talking over each other put a dozen
  // words into two seconds, and that is the recording, not the engine.
  // Calibrated on English and French transcripts: an engine that writes a
  // language one character to a word, as Whisper does Chinese and Japanese,
  // could cross the rate in a fast passage and earn a row it did not
  // deserve, which costs a line in Project info and changes no word.
  // Returns the stretches in time order, [{ start, end, words }] in seconds
  // and words, and an empty array when the timing is plausible throughout.
  const SQUEEZED_WORDS = 12;
  const SQUEEZED_RATE = 8;          // words a second
  const SQUEEZED_MERGE_SECONDS = 3;
  const SQUEEZED_MIN_WORDS = 20;
  function squeezedRanges(words) {
    const list = (Array.isArray(words) ? words : []).filter(timed).slice().sort((a, b) => a.start - b.start);
    const runs = [];
    for (let i = 0; i + SQUEEZED_WORDS <= list.length; i += 1) {
      const from = list[i].start;
      const to = list[i + SQUEEZED_WORDS - 1].end;
      if (to - from >= SQUEEZED_WORDS / SQUEEZED_RATE) continue;
      const last = runs.length > 0 ? runs[runs.length - 1] : null;
      if (last !== null && from <= last.end + SQUEEZED_MERGE_SECONDS) {
        last.end = Math.max(last.end, to);
        last.last = i + SQUEEZED_WORDS - 1;
      } else {
        runs.push({ start: from, end: to, first: i, last: i + SQUEEZED_WORDS - 1 });
      }
    }
    return runs
      .map((run) => ({ start: Math.round(run.start * 100) / 100, end: Math.round(run.end * 100) / 100, words: run.last - run.first + 1 }))
      .filter((run) => run.words >= SQUEEZED_MIN_WORDS);
  }

  const api = { paragraphsFrom, squeezedRanges, transcriptFromWords, transcriptToHtml, withDurations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.HyperaudioConverters = root.HyperaudioConverters || {};
    Object.assign(root.HyperaudioConverters, api);
  }
}(typeof window !== 'undefined' ? window : null));

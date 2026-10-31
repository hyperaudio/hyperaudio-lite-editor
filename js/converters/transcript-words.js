/**
 * converters/transcript-words.js
 * (C) The Hyperaudio Project
 * @version 1.3.43 — last changed in release 1.3.43
 * @license MIT
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

  // The canonical transcript of a word list. The words go through as they
  // are: seconds, text, speaker, and `space: false` on a word glued to the
  // one after it.
  //
  // jsonToHTML writes a speaker label at the head of every paragraph that
  // names one. The engines that diarize always labelled a speaker once, at
  // their first word and at each change, and not again when the same
  // speaker's paragraph broke on a pause or on length: `labelOnChange` keeps
  // that, by leaving the speaker off a paragraph that follows one of the
  // same speaker's. The words keep theirs either way.
  function transcriptFromWords(words, options) {
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

  const api = { paragraphsFrom, transcriptFromWords, transcriptToHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.HyperaudioConverters = root.HyperaudioConverters || {};
    Object.assign(root.HyperaudioConverters, api);
  }
}(typeof window !== 'undefined' ? window : null));

/**
 * converters/parakeet.js
 * (C) The Hyperaudio Project
 * @version 1.3.44 — last changed in release 1.3.44
 * @license AGPL-3.0-only
 *
 * Parakeet's output (#751), from the Hugging Face inference endpoint
 * (verbose_json with word timestamps) and from the editor's own worker alike:
 * `{ words: [{ word, start, end }] }` with times in seconds, as the editor's
 * canonical transcript. Parakeet does not diarize, so there are no speakers.
 * The clients (js/hyperaudio-lite-editor-parakeet.js for the endpoint,
 * js/hyperaudio-lite-editor-parakeet-local.js for the worker) send the audio
 * and put the result on the page. Nothing here touches the page.
 *
 * See converters/transcript-words.js for what every converter returns.
 */
(function (root) {
  'use strict';

  const shared = (root && root.HyperaudioConverters) || (typeof require === 'function' ? require('./transcript-words.js') : null);

  /**
   * A Parakeet word list as the editor's transcript.
   * @param {object} json - `{ words, language? }`
   * @returns {{words: Array, paragraphs: Array, language: (string|undefined)}}
   */
  function parakeet(json) {
    const words = (json.words || []).map((w) => ({ text: w.word, start: w.start, end: w.end }));
    const transcript = shared.transcriptFromWords(words);
    return {
      words: transcript.words,
      paragraphs: transcript.paragraphs,
      // the endpoint names the language, the worker does not
      language: typeof json.language === 'string' && json.language !== '' ? json.language : undefined,
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { parakeet };
  if (root) {
    root.HyperaudioConverters = root.HyperaudioConverters || {};
    root.HyperaudioConverters.parakeet = parakeet;
  }
}(typeof window !== 'undefined' ? window : null));

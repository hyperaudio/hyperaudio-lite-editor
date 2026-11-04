/**
 * converters/whisper.js
 * (C) The Hyperaudio Project
 * @version 1.3.44 — last changed in release 1.3.44
 * @license AGPL-3.0-only
 *
 * The editor's own Whisper (#751): what the transformers.js pipeline returns
 * from the worker, `{ chunks: [{ text, timestamp: [start, end] }] }` with
 * times in seconds, as the editor's canonical transcript. The client
 * (js/hyperaudio-lite-editor-whisper.js) runs the worker and puts the result
 * on the page. Nothing here touches the page.
 *
 * These are the rules the engine has always applied to its own output. A
 * Whisper JSON FILE in this same dialect goes through converters/whisper-json.js
 * instead, which reads five dialects and handles glued words and missing
 * times. Bringing the two together is a change of output, and its own work.
 *
 * See converters/transcript-words.js for what every converter returns.
 */
(function (root) {
  'use strict';

  const shared = (root && root.HyperaudioConverters) || (typeof require === 'function' ? require('./transcript-words.js') : null);

  /**
   * A pipeline output as the editor's transcript.
   * @param {object} output - `{ chunks }`
   * @returns {{words: Array, paragraphs: Array}}
   */
  function whisper(output) {
    // whisper marks word boundaries with a leading space on the text; empty
    // text and text in square brackets (things like [BLANK_AUDIO]) are dropped
    // BEFORE paragraphs are placed, so a dropped noise word cannot hide a pause.
    // The last chunk often has no end: it is given half a second.
    const words = (output.chunks || [])
      .map((chunk) => ({
        text: String(chunk.text === undefined || chunk.text === null ? '' : chunk.text).trim(),
        start: chunk.timestamp[0],
        end: chunk.timestamp[1] === null || chunk.timestamp[1] === undefined ? chunk.timestamp[0] + 0.5 : chunk.timestamp[1],
      }))
      .filter((w) => w.text.length > 0 && w.text.indexOf('[') < 0 && w.text.indexOf(']') < 0);
    return shared.transcriptFromWords(words);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { whisper };
  if (root) {
    root.HyperaudioConverters = root.HyperaudioConverters || {};
    root.HyperaudioConverters.whisper = whisper;
  }
}(typeof window !== 'undefined' ? window : null));

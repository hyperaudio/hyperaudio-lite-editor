/**
 * converters/assemblyai.js
 * (C) The Hyperaudio Project
 * @version 1.3.44 — last changed in release 1.3.44
 * @license AGPL-3.0-only
 *
 * AssemblyAI's transcript (#751): its word list, with times in MILLISECONDS
 * and a `speaker` letter on each word when the request asked for speaker
 * labels, as the editor's canonical transcript. The client
 * (js/hyperaudio-lite-editor-assemblyai.js) uploads, polls and puts the
 * result on the page. Nothing here touches the page.
 *
 * See converters/transcript-words.js for what every converter returns.
 */
(function (root) {
  'use strict';

  const shared = (root && root.HyperaudioConverters) || (typeof require === 'function' ? require('./transcript-words.js') : null);

  /**
   * A completed AssemblyAI transcript as the editor's transcript.
   * @param {object} json - the parsed transcript, with `words`
   * @returns {{words: Array, paragraphs: Array, language: (string|undefined)}}
   */
  function assemblyai(json) {
    const list = json.words || [];
    // speakers only where the transcript has them: labels then go at the
    // first word and at every change of speaker, as the paragraph rule breaks
    const diarized = list.some((w) => w.speaker !== null && w.speaker !== undefined);
    const words = list.map((w) => {
      const word = { text: w.text, start: w.start / 1000, end: w.end / 1000 };
      if (diarized) word.speaker = 'speaker-' + w.speaker;
      return word;
    });
    // a label at the first word and at every change of speaker, as always
    const transcript = shared.transcriptFromWords(words, { labelOnChange: true });
    return {
      words: transcript.words,
      paragraphs: transcript.paragraphs,
      // what AssemblyAI says the language IS: it may have been detected
      language: typeof json.language_code === 'string' && json.language_code !== '' ? json.language_code : undefined,
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { assemblyai };
  if (root) {
    root.HyperaudioConverters = root.HyperaudioConverters || {};
    root.HyperaudioConverters.assemblyai = assemblyai;
  }
}(typeof window !== 'undefined' ? window : null));

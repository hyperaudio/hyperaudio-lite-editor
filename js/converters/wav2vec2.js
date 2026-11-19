/**
 * converters/wav2vec2.js
 * (C) The Hyperaudio Project
 * @version 1.3.52 — last changed in release 1.3.52
 * @license AGPL-3.0-only
 *
 * The More languages engine's output (#815), from its worker
 * (js/more-languages.worker.js), as the editor's canonical transcript. The
 * models there (wav2vec2 with a CTC head, Swecha Gonthuka for Telugu first)
 * predict one letter, a word separator or nothing for every 20 ms of audio.
 * The worker sends that best guess per frame:
 *
 *   { frames: [id, ...], vocab: [token, ...], frameSeconds: 0.02,
 *     blank: id, separator: id, language: 'te' }
 *
 * and this turns it into words: repeats of a letter collapse into one, the
 * blank (CTC's "nothing") is dropped, and a word ends at the separator. A word
 * also ends at a pause, because the model often writes no separator across a
 * silence, and the last word of one sentence ran into the first of the next.
 * A word runs from the first frame of its first letter to the last frame of
 * its last letter. Special tokens (<s>, </s>, <unk>, <pad>) are never text.
 *
 * The client (js/hyperaudio-lite-editor-more-languages.js) puts the result on
 * the page. Nothing here touches the page.
 *
 * See converters/transcript-words.js for what every converter returns.
 */
(function (root) {
  'use strict';

  const shared = (root && root.HyperaudioConverters) || (typeof require === 'function' ? require('./transcript-words.js') : null);

  // silence longer than this ends a word even without a separator: tested on
  // ten minutes of joined Telugu clips, where 0.25 s to 0.6 s gave the same
  // words and left five run-together pairs in about a thousand, against one at
  // nearly every sentence join without it
  const PAUSE_SECONDS = 0.4;
  const isSpecial = (token) => typeof token !== 'string' || token === '' || /^<.*>$/.test(token);
  const round = (seconds) => Math.round(seconds * 1000) / 1000;

  /**
   * Words from the best token per frame.
   * @param {object} json - `{ frames, vocab, frameSeconds, blank, separator, language? }`
   * @returns {{words: Array, paragraphs: Array, language: (string|undefined)}}
   */
  function wav2vec2(json) {
    const frames = Array.from((json && json.frames) || []);
    const vocab = (json && json.vocab) || [];
    const frameSeconds = Number(json && json.frameSeconds) > 0 ? Number(json.frameSeconds) : 0.02;
    const blank = json && json.blank;
    const separator = json && json.separator;

    const words = [];
    let current = null;
    const close = () => {
      if (current !== null && current.text !== '') words.push({ text: current.text, start: round(current.start), end: round(current.end) });
      current = null;
    };
    let previous = null;
    frames.forEach((id, frame) => {
      const at = frame * frameSeconds;
      if (id === previous) {
        // the same letter held: the word lasts to the end of this frame
        if (current !== null && id !== blank && id !== separator) current.end = at + frameSeconds;
        return;
      }
      previous = id;
      if (id === blank) return;
      if (id === separator) { close(); return; }
      const token = vocab[id];
      if (isSpecial(token)) return;
      if (current !== null && at - current.end > PAUSE_SECONDS) close();
      if (current === null) current = { text: '', start: at, end: at + frameSeconds };
      current.text += token;
      current.end = at + frameSeconds;
    });
    close();

    const transcript = shared.transcriptFromWords(words);
    return {
      words: transcript.words,
      paragraphs: transcript.paragraphs,
      language: typeof json.language === 'string' && json.language !== '' ? json.language : undefined,
    };
  }

  wav2vec2.PAUSE_SECONDS = PAUSE_SECONDS;

  if (typeof module !== 'undefined' && module.exports) module.exports = { wav2vec2 };
  if (root) {
    root.HyperaudioConverters = root.HyperaudioConverters || {};
    root.HyperaudioConverters.wav2vec2 = wav2vec2;
  }
}(typeof window !== 'undefined' ? window : null));

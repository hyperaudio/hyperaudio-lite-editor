/**
 * converters/parakeet.js
 * (C) The Hyperaudio Project
 * @version 1.3.46 — last changed in release 1.3.46
 * @license AGPL-3.0-only
 *
 * Parakeet's output (#751), from the Hugging Face inference endpoint
 * (verbose_json with word timestamps) and from the editor's own worker alike:
 * `{ words: [{ word, start, end }] }` with times in seconds, as the editor's
 * canonical transcript, with speakers when DeepInfra's route labelled them
 * (#760) and the stretches whose timing cannot be right, when there are any.
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
  // Whisper through the Hugging Face route (#777) writes its words the way
  // its tokenizer does. A word that follows a space carries that space,
  // " speech", and a piece that continues the word before it does not: "-to",
  // "-text", "'éditer.", "-in,". Trimmed and joined with spaces those read
  // "speech -to -text" and "plug -in,". When a list marks its word starts
  // this way, a piece with no leading space is folded into the word before
  // it, which then runs to the piece's end. Nemotron, Qwen and the editor's
  // own worker never write a leading space, and their lists are left alone.
  const startsWithSpace = (text) => /^\s/.test(text);
  function joinedPieces(words) {
    if (!words.some((w) => startsWithSpace(String(w.word)))) return words;
    const out = [];
    words.forEach((w) => {
      const text = String(w.word);
      if (text.trim() === '') return;
      const previous = out.length > 0 ? out[out.length - 1] : null;
      if (previous !== null && !startsWithSpace(text)) {
        previous.word += text;
        previous.end = Math.max(previous.end, w.end);
        return;
      }
      // a joined word keeps its first piece's speaker
      out.push({ word: text, start: w.start, end: w.end, speaker: w.speaker });
    });
    return out;
  }

  // DeepInfra's own route labels words speaker_0, speaker_1… when asked to
  // (#760). The editor's label is "speaker-0", in step with the Deepgram and
  // AssemblyAI converters, so the markup reads the same whichever engine
  // heard the speakers. A list with no speaker on any word has none.
  const hasSpeaker = (w) => w.speaker !== undefined && w.speaker !== null && w.speaker !== '';
  function speakerLabel(speaker) {
    const m = /^speaker[_-]?(.+)$/i.exec(String(speaker).trim());
    return 'speaker-' + (m ? m[1] : String(speaker).trim());
  }

  function parakeet(json) {
    const pieces = joinedPieces(json.words || []);
    const diarized = pieces.some(hasSpeaker);
    const words = pieces.map((w) => {
      const word = { text: w.word === undefined || w.word === null ? '' : String(w.word).trim(), start: w.start, end: w.end };
      if (diarized && hasSpeaker(w)) word.speaker = speakerLabel(w.speaker);
      return word;
    });
    // a speaker label at the first word and at every change of speaker, as
    // the other diarizing converters do; without speakers the option is moot
    const transcript = shared.transcriptFromWords(words, { labelOnChange: true });
    const result = {
      words: transcript.words,
      paragraphs: transcript.paragraphs,
      // the endpoint names the language, the worker does not. Nemotron on the
      // Hugging Face router echoes the request: "" or the literal "auto" when
      // none was asked for (#777), and neither names a language
      language: typeof json.language === 'string' && json.language !== '' && json.language !== 'auto' ? json.language : undefined,
    };
    // Where the times cannot be right (#786): Nemotron on a long recording stamps a
    // passage into a few seconds (squeezedRanges, in transcript-words.js).
    // The words stay as they came, since nothing here knows where they
    // belong, and the stretches go with the result for the client to name.
    // Only when there are any, so a plausible transcript reads as before.
    const unreliable = shared.squeezedRanges(transcript.words);
    if (unreliable.length > 0) result.unreliableTiming = unreliable;
    return result;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { parakeet };
  if (root) {
    root.HyperaudioConverters = root.HyperaudioConverters || {};
    root.HyperaudioConverters.parakeet = parakeet;
  }
}(typeof window !== 'undefined' ? window : null));

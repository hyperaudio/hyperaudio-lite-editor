/**
 * paragraph-rule.js
 * (C) The Hyperaudio Project
 * @version 1.3.45 — last changed in release 1.3.45
 * @license AGPL-3.0-only
 *
 * Where a transcript's paragraphs start (#743). One rule for every engine and
 * every import, so the same recording reads the same however it arrived. It
 * is the rule the Parakeet engines always used, with one clause added:
 *
 *  - a change of speaker always starts a new paragraph, wherever it falls;
 *  - otherwise a paragraph only ends at a sentence end (a word whose last
 *    character is . ? or !), and does so when the next word follows a gap of
 *    more than 4 s, or of more than 1 s once the paragraph has 20 words, or
 *    when the paragraph has passed 100 words.
 *
 * The 1 s clause is for the engines that time words edge to edge — Nemotron,
 * Whisper and Qwen on the Hugging Face route among them — where a word ends
 * when the next begins and a speaker's pause between sections comes out as
 * one to two seconds, never four. Without it a 64 s talk with six clear
 * section breaks was one paragraph until the 100-word line.
 *
 * words: [{ start, end, text, speaker? }], times in seconds, in order.
 * Returns a Set of the indices of the words a new paragraph starts AT (the
 * first word is never in it: it starts the first paragraph by definition).
 * Callers build their own markup and ask set.has(i) before each word.
 *
 * Remove this file and its <script> tag, and every caller falls back to a
 * single paragraph (the editor's sanitise and the project format both cope).
 */
(function (root) {
  const SIGNIFICANT_GAP_SECONDS = 4.0;
  const SHORT_GAP_SECONDS = 1.0;
  const WORDS_BEFORE_SHORT_GAP_COUNTS = 20;
  const MAX_WORDS_IN_PARAGRAPH = 100;

  const endsSentence = (text) => {
    const t = String(text === undefined || text === null ? '' : text);
    const last = t.charAt(t.length - 1);
    return last === '.' || last === '?' || last === '!';
  };
  // no speaker and an empty one are the same: a source without speakers
  // must never look like it changed speaker
  const speakerOf = (word) => (word && word.speaker !== undefined && word.speaker !== null && word.speaker !== ''
    ? String(word.speaker) : null);

  function paragraphStarts(words) {
    const starts = new Set();
    const list = Array.isArray(words) ? words : [];
    let previousEnd = 0;
    let wordsInParagraph = 0;
    for (let i = 0; i < list.length; i += 1) {
      const word = list[i];
      wordsInParagraph += 1;
      if (i > 0) {
        if (speakerOf(word) !== speakerOf(list[i - 1])) {
          starts.add(i);
          wordsInParagraph = 0; // as the Parakeet loop reset it: the word just placed is not counted
        } else if (((previousEnd !== 0 && (word.start - previousEnd) > SIGNIFICANT_GAP_SECONDS)
            || (previousEnd !== 0 && (word.start - previousEnd) > SHORT_GAP_SECONDS && wordsInParagraph > WORDS_BEFORE_SHORT_GAP_COUNTS)
            || wordsInParagraph > MAX_WORDS_IN_PARAGRAPH)
            && endsSentence(list[i - 1].text)) {
          starts.add(i);
          wordsInParagraph = 0; // as the Parakeet loop reset it: the word just placed is not counted
        }
      }
      previousEnd = word.end;
    }
    return starts;
  }

  const api = { paragraphStarts, SIGNIFICANT_GAP_SECONDS, SHORT_GAP_SECONDS, WORDS_BEFORE_SHORT_GAP_COUNTS, MAX_WORDS_IN_PARAGRAPH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.hyperaudioParagraphStarts = paragraphStarts;
}(typeof window !== 'undefined' ? window : null));

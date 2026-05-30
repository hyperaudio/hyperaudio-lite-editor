/*! (C) The Hyperaudio Project. AGPL 3.0 @license: https://www.gnu.org/licenses/agpl-3.0.en.html */

(function(root, factory) {
  const exports = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  Object.assign(root, exports);
})(typeof window !== 'undefined' ? window : globalThis, function() {
  function hasUsableOffsets(word) {
    return Number.isInteger(word.startOffset) && Number.isInteger(word.endOffset);
  }

  function getWordTextFromTranscript(word, transcript) {
    if (transcript && hasUsableOffsets(word)) {
      const text = transcript.slice(word.startOffset, word.endOffset).trim();
      if (text) return text;
    }

    return String(word.word || word.alignedWord || '').trim();
  }

  function getGap(transcript, word, nextWord) {
    if (!transcript || !hasUsableOffsets(word)) {
      return '';
    }

    if (!nextWord || !hasUsableOffsets(nextWord)) {
      return transcript.slice(word.endOffset);
    }

    return transcript.slice(word.endOffset, nextWord.startOffset);
  }

  function stripGentleMarkup(text) {
    return text
      .replace(/\[\+\]/g, '')
      .replace(/\|\|/g, '')
      .replace(/\\+/g, '')
      .replace(/\s+/g, '');
  }

  function trailingTextBeforeMarkup(gap) {
    const markupIndex = gap.search(/\[\+\]|\|\||\\|(?:\r?\n\s*){2,}/);
    const trailing = markupIndex === -1 ? gap : gap.slice(0, markupIndex);

    return stripGentleMarkup(trailing);
  }

  function getTrailingWordText(transcript, word, nextWord) {
    return trailingTextBeforeMarkup(getGap(transcript, word, nextWord));
  }

  function startsNewParagraph(gap) {
    return /\|\|/.test(gap) || /(?:\r?\n\s*){2,}/.test(gap);
  }

  function successfulGentleWords(gentleData) {
    return ((gentleData && gentleData.words) || [])
      .filter((word) => (!word.case || word.case === 'success') && typeof word.start === 'number' && typeof word.end === 'number')
      .sort((a, b) => a.start - b.start);
  }

  function closeParagraph(paragraphs, paragraphStart, paragraphEnd) {
    if (!paragraphStart || !paragraphEnd) return;

    paragraphs.push({
      speaker: null,
      start: paragraphStart.start,
      end: paragraphEnd.end
    });
  }

  function buildParagraphsByTiming(words, maxGap = 1.5) {
    if (words.length === 0) return [];

    const paragraphs = [];
    let paragraphStart = words[0];
    let previous = words[0];

    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      const gap = word.start - previous.end;
      const endsSentence = /[.!?]$/.test(previous.text);

      if (gap > maxGap && endsSentence) {
        closeParagraph(paragraphs, paragraphStart, previous);
        paragraphStart = word;
      }

      previous = word;
    }

    closeParagraph(paragraphs, paragraphStart, previous);
    return paragraphs;
  }

  function gentleJsonToHyperaudioJson(gentleData) {
    const transcript = String((gentleData && gentleData.transcript) || '');
    const sourceWords = successfulGentleWords(gentleData);
    const words = [];
    const paragraphs = [];
    let paragraphStart = null;
    let previousSourceWord = null;
    let previousOutputWord = null;

    for (let i = 0; i < sourceWords.length; i++) {
      const sourceWord = sourceWords[i];
      const nextSourceWord = sourceWords[i + 1] || null;
      const gapBefore = previousSourceWord ? getGap(transcript, previousSourceWord, sourceWord) : '';

      if (previousOutputWord && startsNewParagraph(gapBefore)) {
        closeParagraph(paragraphs, paragraphStart, previousOutputWord);
        paragraphStart = null;
      }

      const gapAfter = getGap(transcript, sourceWord, nextSourceWord);
      const text = getWordTextFromTranscript(sourceWord, transcript) + getTrailingWordText(transcript, sourceWord, nextSourceWord);

      if (text) {
        const outputWord = {
          start: sourceWord.start,
          end: sourceWord.end,
          text: text
        };

        words.push(outputWord);
        if (!paragraphStart) paragraphStart = outputWord;
        previousOutputWord = outputWord;
      }

      if (previousOutputWord && startsNewParagraph(gapAfter)) {
        closeParagraph(paragraphs, paragraphStart, previousOutputWord);
        paragraphStart = null;
      }

      previousSourceWord = sourceWord;
    }

    if (paragraphStart && previousOutputWord) {
      closeParagraph(paragraphs, paragraphStart, previousOutputWord);
    }

    const finalParagraphs = paragraphs.length > 0 ? paragraphs : buildParagraphsByTiming(words);
    const sections = words.length > 0
      ? [{ start: words[0].start, end: words[words.length - 1].end }]
      : [];

    return { words, paragraphs: finalParagraphs, sections };
  }

  function splitTrailingPunctuation(text) {
    const value = String(text || '').trim();
    const match = value.match(/^(.+?)([.,!?;:]+|-)?$/);

    if (!match) {
      return { core: value, suffix: '' };
    }

    return {
      core: match[1] || value,
      suffix: match[2] || ''
    };
  }

  function shouldJoinNextWord(suffix) {
    return suffix === '-';
  }

  function hyperaudioJsonToGentleJson(hyperaudioData) {
    const words = ((hyperaudioData && hyperaudioData.words) || [])
      .filter((word) => typeof word.start === 'number' && typeof word.end === 'number' && String(word.text || '').trim())
      .sort((a, b) => a.start - b.start);

    const transcriptParts = [];
    const gentleWords = [];
    let offset = 0;
    let joinNextWord = false;

    for (const word of words) {
      const { core, suffix } = splitTrailingPunctuation(word.text);
      if (!core) continue;

      if (transcriptParts.length > 0 && !joinNextWord) {
        transcriptParts.push(' ');
        offset += 1;
      }

      const startOffset = offset;
      transcriptParts.push(core);
      offset += core.length;
      const endOffset = offset;

      if (suffix) {
        transcriptParts.push(suffix);
        offset += suffix.length;
      }

      gentleWords.push({
        alignedWord: core.toLowerCase(),
        case: 'success',
        end: word.end,
        endOffset: endOffset,
        phones: [],
        start: word.start,
        startOffset: startOffset,
        word: core
      });

      joinNextWord = shouldJoinNextWord(suffix);
    }

    return {
      transcript: transcriptParts.join(''),
      words: gentleWords
    };
  }

  return {
    gentleJsonToHyperaudioJson,
    hyperaudioJsonToGentleJson
  };
});

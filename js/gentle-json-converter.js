(function(root) {
  function cleanGentleMarkerText(value) {
    return String(value || '')
      .replace(/\[\+\]/g, '')
      .replace(/\\+/g, '')
      .replace(/\|\|/g, '')
      .trim();
  }

  function isParagraphBreak(value) {
    return /\|\|/.test(String(value || ''));
  }

  function addParagraph(paragraphs, words, startIndex) {
    if (startIndex === null || words.length <= startIndex) {
      return null;
    }

    paragraphs.push({
      start: words[startIndex].start,
      end: words[words.length - 1].end
    });

    return null;
  }

  function gentleToHyperaudioJson(gentleData) {
    const words = [];
    const paragraphs = [];
    let paragraphStartIndex = null;
    const gentleWords = (gentleData && gentleData.words) || [];

    gentleWords.forEach(gentleWord => {
      const rawText = gentleWord.word || gentleWord.alignedWord || '';
      const text = cleanGentleMarkerText(rawText);
      const start = Number(gentleWord.start);
      const end = Number(gentleWord.end);
      const breaksParagraph = isParagraphBreak(rawText);

      if (text && Number.isFinite(start) && Number.isFinite(end)) {
        if (paragraphStartIndex === null) {
          paragraphStartIndex = words.length;
        }

        words.push({ start, end, text });
      }

      if (breaksParagraph) {
        paragraphStartIndex = addParagraph(paragraphs, words, paragraphStartIndex);
      }
    });

    addParagraph(paragraphs, words, paragraphStartIndex);

    const sections = words.length ? [{
      start: words[0].start,
      end: words[words.length - 1].end,
      mediaUrl: (gentleData && gentleData.mediaUrl) || ''
    }] : [];

    return { words, paragraphs, sections };
  }

  function getParagraphEndWordIndexes(words, paragraphs) {
    const endIndexes = new Set();
    const epsilon = 0.000001;

    paragraphs.forEach(paragraph => {
      let endIndex = -1;

      words.forEach((word, index) => {
        const wordStart = Number(word.start);
        const wordEnd = Number(word.end);
        const paragraphStart = Number(paragraph.start);
        const paragraphEnd = Number(paragraph.end);

        if (
          Number.isFinite(wordStart) &&
          Number.isFinite(wordEnd) &&
          Number.isFinite(paragraphStart) &&
          Number.isFinite(paragraphEnd) &&
          wordStart + epsilon >= paragraphStart &&
          wordEnd <= paragraphEnd + epsilon
        ) {
          endIndex = index;
        }
      });

      if (endIndex !== -1) {
        endIndexes.add(endIndex);
      }
    });

    return endIndexes;
  }

  function hyperaudioJsonToGentle(jsonData) {
    const words = (jsonData && jsonData.words) || [];
    const paragraphs = (jsonData && jsonData.paragraphs) || [];
    const paragraphEndIndexes = getParagraphEndWordIndexes(words, paragraphs);
    const transcriptParts = [];
    let offset = 0;

    const gentleWords = words.map((word, index) => {
      const text = String(word.text || '').trim();
      const gentleText = paragraphEndIndexes.has(index) ? `${text}||` : text;
      const startOffset = offset;
      transcriptParts.push(gentleText);
      offset += gentleText.length;
      const endOffset = offset;
      offset += 1;

      return {
        alignedWord: text.toLowerCase(),
        case: 'success',
        end: Number(word.end),
        endOffset,
        phones: [],
        start: Number(word.start),
        startOffset,
        word: gentleText
      };
    });

    return {
      transcript: transcriptParts.join(' '),
      words: gentleWords
    };
  }

  root.gentleToHyperaudioJson = gentleToHyperaudioJson;
  root.hyperaudioJsonToGentle = hyperaudioJsonToGentle;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      gentleToHyperaudioJson,
      hyperaudioJsonToGentle
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);

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

  function hyperaudioJsonToGentle(jsonData) {
    const words = (jsonData && jsonData.words) || [];
    const transcriptParts = [];
    let offset = 0;

    const gentleWords = words.map(word => {
      const text = String(word.text || '').trim();
      const startOffset = offset;
      transcriptParts.push(text);
      offset += text.length;
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
        word: text
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

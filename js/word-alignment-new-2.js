function stripPunctuation(word) {
  return word.replace(/[.,!?;:'"]+$/, '');
}

function normalizeWord(word) {
  return stripPunctuation(word.toLowerCase());
}

function extractWordsFromJSON(jsonData) {
  const words = [];
  const timings = [];
  
  (jsonData.words || []).forEach(word => {
    if (word.text && word.text.trim()) {
      words.push(word.text.trim());
      timings.push({
        start: word.start,
        end: word.end
      });
    }
  });
  
  return { words, timings };
}

function extractWordsFromPlainText(plainText, sourceWords) {
  const sourceWordsSet = new Set(sourceWords.map(w => normalizeWord(w)));
  const lines = plainText.split(/\n/);
  let allWords = [];
  
  lines.forEach(line => {
    const trimmedLine = line.trim();
    
    if (trimmedLine.length === 0) {
      return;
    }
    
    const lineWords = trimmedLine.split(/\s+/).filter(w => w.length > 0);
    
    if (lineWords.length > 0) {
      const firstWord = lineWords[0];
      const firstWordNormalized = normalizeWord(firstWord);
      const isSpeaker = !sourceWordsSet.has(firstWordNormalized);
      
      let wordsToAdd = lineWords;
      
      if (isSpeaker) {
        wordsToAdd = lineWords.slice(1);
      }
      
      allWords = allWords.concat(wordsToAdd);
    }
  });
  
  return allWords;
}

function detectParagraphs(plainText, sourceWords) {
  const sourceWordsSet = new Set(sourceWords.map(w => normalizeWord(w)));
  const lines = plainText.split(/\n/);
  const paragraphMap = [];
  let wordIndex = 0;
  
  lines.forEach(line => {
    const trimmedLine = line.trim();
    
    if (trimmedLine.length === 0) {
      return;
    }
    
    const lineWords = trimmedLine.split(/\s+/).filter(w => w.length > 0);
    
    if (lineWords.length > 0) {
      const firstWord = lineWords[0];
      const firstWordNormalized = normalizeWord(firstWord);
      const isSpeaker = !sourceWordsSet.has(firstWordNormalized);
      
      let speaker = null;
      let paragraphWords = lineWords;
      
      if (isSpeaker) {
        speaker = firstWord.replace(/:$/, '');
        paragraphWords = lineWords.slice(1);
      }
      
      if (paragraphWords.length > 0) {
        paragraphMap.push({
          startWordIndex: wordIndex,
          endWordIndex: wordIndex + paragraphWords.length - 1,
          wordCount: paragraphWords.length,
          speaker: speaker
        });
        
        wordIndex += paragraphWords.length;
      }
    }
  });
  
  return paragraphMap;
}

function alignWords(sourceWords, targetWords) {
  const m = sourceWords.length;
  const n = targetWords.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (sourceWords[i-1].toLowerCase() === targetWords[j-1].toLowerCase()) {
        dp[i][j] = dp[i-1][j-1];
      } else {
        dp[i][j] = Math.min(
          dp[i-1][j-1] + 1,
          dp[i-1][j] + 1,
          dp[i][j-1] + 1
        );
      }
    }
  }
  
  const alignment = [];
  let i = m, j = n;
  
  while (i > 0 || j > 0) {
    if (i === 0) {
      alignment.push({ type: 'insert', sourceIdx: null, targetIdx: j-1 });
      j--;
    } else if (j === 0) {
      alignment.push({ type: 'delete', sourceIdx: i-1, targetIdx: null });
      i--;
    } else {
      const current = dp[i][j];
      if (sourceWords[i-1].toLowerCase() === targetWords[j-1].toLowerCase()) {
        alignment.push({ type: 'match', sourceIdx: i-1, targetIdx: j-1 });
        i--;
        j--;
      } else if (current === dp[i-1][j-1] + 1) {
        alignment.push({ type: 'substitute', sourceIdx: i-1, targetIdx: j-1 });
        i--;
        j--;
      } else if (current === dp[i-1][j] + 1) {
        alignment.push({ type: 'delete', sourceIdx: i-1, targetIdx: null });
        i--;
      } else {
        alignment.push({ type: 'insert', sourceIdx: null, targetIdx: j-1 });
        j--;
      }
    }
  }
  
  alignment.reverse();
  return alignment;
}

function generateAlignedJSON(alignment, sourceWords, targetWords, timings, plainText) {
  const outputWords = [];
  let lastTiming = null;
  
  alignment.forEach((align, idx) => {
    if (align.type === 'match' || align.type === 'substitute') {
      const timing = timings[align.sourceIdx];
      outputWords.push({
        word: targetWords[align.targetIdx],
        start: timing.start,
        end: timing.end,
        targetIdx: align.targetIdx
      });
      lastTiming = timing;
    } else if (align.type === 'insert') {
      let nextTiming = null;
      for (let i = idx + 1; i < alignment.length; i++) {
        if (alignment[i].type === 'match' || alignment[i].type === 'substitute') {
          nextTiming = timings[alignment[i].sourceIdx];
          break;
        }
      }
      
      const timing = nextTiming || lastTiming || { start: 0, end: 0.1 };
      outputWords.push({
        word: targetWords[align.targetIdx],
        start: timing.start,
        end: timing.end,
        targetIdx: align.targetIdx
      });
    }
  });
  
  const paragraphMap = detectParagraphs(plainText, sourceWords);
  
  const jsonWords = outputWords.map(item => ({
    start: item.start,
    end: item.end,
    text: item.word
  }));
  
  const jsonParagraphs = [];
  
  if (paragraphMap.length > 0) {
    paragraphMap.forEach(paragraph => {
      // FIXED: Use strict comparison to avoid overlap
      const paragraphWords = outputWords.filter(item =>
        item.targetIdx >= paragraph.startWordIndex &&
        item.targetIdx <= paragraph.endWordIndex
      );
      
      if (paragraphWords.length > 0) {
        const paragraphObj = {
          start: paragraphWords[0].start,
          end: paragraphWords[paragraphWords.length - 1].end
        };
        
        if (paragraph.speaker) {
          paragraphObj.speaker = paragraph.speaker;
        }
        
        jsonParagraphs.push(paragraphObj);
      }
    });
  } else if (outputWords.length > 0) {
    jsonParagraphs.push({
      start: outputWords[0].start,
      end: outputWords[outputWords.length - 1].end
    });
  }
  
  return {
    words: jsonWords,
    paragraphs: jsonParagraphs
  };
}

function alignTranscripts(machineTranscript, correctedText) {
  const { words: sourceWords, timings } = extractWordsFromJSON(machineTranscript);
  const targetWords = extractWordsFromPlainText(correctedText, sourceWords);
  const alignment = alignWords(sourceWords, targetWords);
  const alignedJSON = generateAlignedJSON(alignment, sourceWords, targetWords, timings, correctedText);
  return alignedJSON;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    alignTranscripts,
    extractWordsFromJSON,
    extractWordsFromPlainText,
    detectParagraphs,
    alignWords,
    generateAlignedJSON,
    stripPunctuation,
    normalizeWord
  };
}
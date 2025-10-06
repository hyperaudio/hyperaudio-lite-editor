/**
 * ============================================================================
 * TRANSCRIPT ALIGNMENT ALGORITHM
 * ============================================================================
 * 
 * PURPOSE:
 * Align a machine-generated transcript (with timing data) with a human-corrected
 * transcript (without timing data) to produce a corrected transcript with accurate
 * timing information.
 * 
 * INTERNAL FORMAT: JSON
 * All algorithms work with JSON format internally. Use conversion.js for HTML.
 * 
 * JSON FORMAT:
 * {
 *   "words": [
 *     {"start": 4.76, "end": 5.28, "text": "word"},
 *     ...
 *   ],
 *   "paragraphs": [
 *     {"speaker": "Name", "start": 4.76, "end": 10.0},
 *     ...
 *   ]
 * }
 * - Times in seconds (floating point)
 * - Paragraphs are optional
 * - Speaker labels are optional
 * 
 * ============================================================================
 */

/**
 * HELPER FUNCTION: stripPunctuation
 */
function stripPunctuation(word) {
  return word.replace(/[.,!?;:'"]+$/, '');
}

/**
 * HELPER FUNCTION: normalizeWord
 */
function normalizeWord(word) {
  return stripPunctuation(word.toLowerCase());
}

/**
 * FUNCTION: extractWordsFromJSON
 */
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

/**
 * FUNCTION: extractWordsFromPlainText
 */
function extractWordsFromPlainText(plainText) {
  const lines = plainText.split(/\n/);
  let allWords = [];
  
  lines.forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine.length > 0) {
      const words = trimmedLine.split(/\s+/).filter(w => w.length > 0);
      allWords = allWords.concat(words);
    }
  });
  
  return allWords;
}

/**
 * FUNCTION: detectParagraphs
 * 
 * CHANGES:
 * - Split by single newlines (not double)
 * - If first word of paragraph not in source transcript, treat it as speaker
 */
function detectParagraphs(plainText, sourceWords) {
  // Create a set of normalized source words for quick lookup
  const sourceWordsSet = new Set(sourceWords.map(w => normalizeWord(w)));
  
  // Split by single newlines
  const lines = plainText.split(/\n/);
  
  const paragraphMap = [];
  let wordIndex = 0;
  
  lines.forEach((line, lineIndex) => {
    const trimmedLine = line.trim();
    
    if (trimmedLine.length > 0) {
      // Split into words
      const lineWords = trimmedLine.split(/\s+/).filter(w => w.length > 0);
      
      if (lineWords.length > 0) {
        // Check if first word is a speaker (not in source transcript)
        const firstWord = lineWords[0];
        const firstWordNormalized = normalizeWord(firstWord);
        const isSpeaker = !sourceWordsSet.has(firstWordNormalized);
        
        let speaker = null;
        let paragraphWords = lineWords;
        
        if (isSpeaker) {
          // First word is the speaker, remove trailing colon if present
          speaker = firstWord.replace(/:$/, '');
          // Remove speaker from word list
          paragraphWords = lineWords.slice(1);
        }
        
        if (paragraphWords.length > 0) {
          paragraphMap.push({
            paragraphIndex: lineIndex,
            startWordIndex: wordIndex,
            endWordIndex: wordIndex + paragraphWords.length - 1,
            wordCount: paragraphWords.length,
            speaker: speaker
          });
          
          wordIndex += paragraphWords.length;
        }
      }
    }
  });
  
  return paragraphMap;
}

/**
 * FUNCTION: alignWords
 */
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

/**
 * FUNCTION: generateAlignedJSON
 */
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
      
      const timing = nextTiming || lastTiming;
      
      if (timing) {
        outputWords.push({
          word: targetWords[align.targetIdx],
          start: timing.start,
          end: timing.end,
          targetIdx: align.targetIdx
        });
      } else {
        outputWords.push({
          word: targetWords[align.targetIdx],
          start: 0,
          end: 0.1,
          targetIdx: align.targetIdx
        });
      }
    }
  });
  
  // Get source words for speaker detection
  const paragraphMap = detectParagraphs(plainText, sourceWords);
  
  const jsonWords = outputWords.map(item => ({
    start: item.start,
    end: item.end,
    text: item.word
  }));
  
  const jsonParagraphs = [];
  
  if (paragraphMap.length > 0) {
    paragraphMap.forEach(paragraph => {
      const paragraphWords = outputWords.filter(item =>
        item.targetIdx >= paragraph.startWordIndex &&
        item.targetIdx <= paragraph.endWordIndex
      );
      
      if (paragraphWords.length > 0) {
        const firstWord = paragraphWords[0];
        const lastWord = paragraphWords[paragraphWords.length - 1];
        
        const paragraphObj = {
          start: firstWord.start,
          end: lastWord.end
        };
        
        if (paragraph.speaker) {
          paragraphObj.speaker = paragraph.speaker;
        }
        
        jsonParagraphs.push(paragraphObj);
      }
    });
  } else {
    if (outputWords.length > 0) {
      const firstWord = outputWords[0];
      const lastWord = outputWords[outputWords.length - 1];
      
      jsonParagraphs.push({
        start: firstWord.start,
        end: lastWord.end
      });
    }
  }
  
  return {
    words: jsonWords,
    paragraphs: jsonParagraphs
  };
}

/**
 * FUNCTION: alignTranscripts
 * 
 * Main entry point for transcript alignment using JSON format
 */
function alignTranscripts(machineTranscript, correctedText) {
  const { words: sourceWords, timings } = extractWordsFromJSON(machineTranscript);
  
  const targetWords = extractWordsFromPlainText(correctedText);
  
  const alignment = alignWords(sourceWords, targetWords);
  
  const alignedJSON = generateAlignedJSON(
    alignment,
    sourceWords,
    targetWords,
    timings,
    correctedText
  );
  
  return alignedJSON;
}

/**
 * EXPORTS
 */
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
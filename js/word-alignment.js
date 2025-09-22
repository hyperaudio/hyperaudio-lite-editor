// Extract words and timings from HTML
// This function parses the input HTML and extracts:
// 1. The text content of each span (the words)
// 2. The timing attributes (data-m for start time, data-d for duration)
// 3. The original HTML structure
function extractTimedWords(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  const spans = doc.querySelectorAll('span[data-m][data-d]');
  
  const words = [];
  const timings = [];
  
  spans.forEach(span => {
    const word = span.textContent.trim();
    if (word && !span.classList.contains('speaker')) { // Skip speaker spans
      words.push(word);
      
      const start = parseInt(span.getAttribute('data-m'));
      const duration = parseInt(span.getAttribute('data-d'));
      
      timings.push({ 
        start, 
        duration, 
        end: start + duration 
      });
    }
  });
  
  // Preserve the original HTML structure
  const htmlStructure = html.trim();
  
  return { words, timings, htmlStructure };
}

// Helper functions for word alignment
function stripPunctuation(word) {
  return word.replace(/[.,!?;:'"]+$/, '');
}

function normalizeWord(word) {
  return stripPunctuation(word.toLowerCase());
}

// Simple word alignment using edit distance
function alignWords(sourceWords, targetWords) {
  const m = sourceWords.length;
  const n = targetWords.length;
  
  // Create DP table
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  // Initialize base cases
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  // Fill DP table
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (sourceWords[i-1].toLowerCase() === targetWords[j-1].toLowerCase()) {
        dp[i][j] = dp[i-1][j-1];
      } else {
        dp[i][j] = Math.min(
          dp[i-1][j-1] + 1,  // substitute
          dp[i-1][j] + 1,    // delete
          dp[i][j-1] + 1     // insert
        );
      }
    }
  }
  
  // Backtrack to find alignment
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

// Detect paragraph breaks and speakers in the original input text
function detectParagraphBreaks(plainText) {
  // Split by double newlines (paragraph breaks)
  const paragraphs = plainText.split(/\n\s*\n/);
  
  // Map each paragraph to its word positions and speaker info
  const paragraphMap = [];
  let wordIndex = 0;
  
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const trimmedParagraph = paragraph.trim();
    if (trimmedParagraph.length > 0) {
      // Check if paragraph starts with a speaker name in square brackets
      const speakerMatch = trimmedParagraph.match(/^\[([^\]]+)\]\s*/);
      let speaker = null;
      let paragraphText = trimmedParagraph;
      
      if (speakerMatch) {
        speaker = speakerMatch[1]; // Extract speaker name without brackets
        paragraphText = trimmedParagraph.substring(speakerMatch[0].length); // Remove speaker from text
      }
      
      const paragraphWords = paragraphText.split(/\s+/).filter(w => w.length > 0);
      
      if (paragraphWords.length > 0) {
        paragraphMap.push({
          paragraphIndex: paragraphIndex,
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

// Extract words from plain text, excluding speaker names
function extractWordsWithoutSpeakers(plainText) {
  // Split by double newlines to get paragraphs
  const paragraphs = plainText.split(/\n\s*\n/);
  let allWords = [];
  
  paragraphs.forEach(paragraph => {
    const trimmedParagraph = paragraph.trim();
    if (trimmedParagraph.length > 0) {
      // Remove speaker name if present
      const paragraphText = trimmedParagraph.replace(/^\[([^\]]+)\]\s*/, '');
      const words = paragraphText.split(/\s+/).filter(w => w.length > 0);
      allWords = allWords.concat(words);
    }
  });
  
  return allWords;
}

// Generate new HTML with aligned timings and paragraph structure
function generateAlignedHTML(alignment, sourceWords, targetWords, timings, originalHtml, plainText) {
  // Build the output array first
  const output = [];
  let lastTiming = null;
  
  alignment.forEach((align, idx) => {
    if (align.type === 'match' || align.type === 'substitute') {
      const timing = timings[align.sourceIdx];
      output.push({
        word: targetWords[align.targetIdx],
        start: timing.start,
        duration: timing.duration,
        targetIdx: align.targetIdx
      });
      lastTiming = timing;
    } else if (align.type === 'insert') {
      // Find next timing for interpolation
      let nextTiming = null;
      for (let i = idx + 1; i < alignment.length; i++) {
        if (alignment[i].type === 'match' || alignment[i].type === 'substitute') {
          nextTiming = timings[alignment[i].sourceIdx];
          break;
        }
      }
      
      const timing = nextTiming || lastTiming;
      if (timing) {
        output.push({
          word: targetWords[align.targetIdx],
          start: timing.start,
          duration: timing.duration,
          targetIdx: align.targetIdx
        });
      } else {
        // Fallback timing if no timing available
        output.push({
          word: targetWords[align.targetIdx],
          start: 0,
          duration: 100,
          targetIdx: align.targetIdx
        });
      }
    }
    // Skip deleted words (they don't appear in the new transcript)
  });
  
  // Detect paragraph breaks in the plain text
  const paragraphMap = detectParagraphBreaks(plainText);
  
  // Generate HTML with paragraph structure
  let html = '<article><section>\n';
  
  if (paragraphMap.length > 0) {
    // Generate multiple paragraphs
    paragraphMap.forEach((paragraph, paragraphIndex) => {
      html += '  <p>\n';
      
      // Add speaker span if present (speakers are not part of the alignment, so we add them separately)
      if (paragraph.speaker) {
        // Get the timing of the first word in this paragraph for the speaker
        const paragraphWords = output.filter(item => 
          item.targetIdx >= paragraph.startWordIndex && 
          item.targetIdx <= paragraph.endWordIndex
        );
        
        const firstWordTiming = paragraphWords.length > 0 ? paragraphWords[0].start : 0;
        html += `    <span data-m="${firstWordTiming}" data-d="0" class="speaker">[${paragraph.speaker}] </span>\n`;
      }
      
      // Add words for this paragraph
      const paragraphWords = output.filter(item => 
        item.targetIdx >= paragraph.startWordIndex && 
        item.targetIdx <= paragraph.endWordIndex
      );
      
      paragraphWords.forEach(item => {
        html += `    <span data-m="${item.start}" data-d="${item.duration}">${item.word} </span>\n`;
      });
      
      html += '  </p>\n';
    });
  } else {
    // Single paragraph fallback
    html += '  <p>\n';
    output.forEach(item => {
      html += `    <span data-m="${item.start}" data-d="${item.duration}">${item.word} </span>\n`;
    });
    html += '  </p>\n';
  }
  
  html += '</section></article>';
  return html;
}

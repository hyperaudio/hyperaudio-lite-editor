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

// Generate new HTML with aligned timings
function generateAlignedHTML(alignment, sourceWords, targetWords, timings, originalHtml) {
  // Build the output array first
  const output = [];
  let lastTiming = null;
  
  alignment.forEach((align, idx) => {
    if (align.type === 'match' || align.type === 'substitute') {
      const timing = timings[align.sourceIdx];
      output.push({
        word: targetWords[align.targetIdx],
        start: timing.start,
        duration: timing.duration
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
          duration: timing.duration
        });
      } else {
        // Fallback timing if no timing available
        output.push({
          word: targetWords[align.targetIdx],
          start: 0,
          duration: 100
        });
      }
    }
    // Skip deleted words (they don't appear in the new transcript)
  });
  
  // Parse the original HTML to preserve structure
  const parser = new DOMParser();
  const doc = parser.parseFromString(originalHtml, 'text/html');
  
  // Generate spans HTML
  let spansHtml = '';
  output.forEach(item => {
    spansHtml += `<span data-m="${item.start}" data-d="${item.duration}">${item.word} </span>`;
  });
  
  // Find all <p> tags and replace their content
  const pTags = doc.querySelectorAll('p');
  if (pTags.length > 0) {
    // Replace content of first p tag with our new spans
    pTags[0].innerHTML = spansHtml;
    // Output just the modified p tag, not the entire body
    return pTags[0].outerHTML;
  } else {
    // If no p tags found, wrap in p tags
    return `<p>${spansHtml}</p>`;
  }
}

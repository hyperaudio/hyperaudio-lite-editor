/**
 * ============================================================================
 * TRANSCRIPT ALIGNMENT ALGORITHM
 * @version 1.3.8 — reworked for #425
 *
 * Portions derived from ts-aligner (https://github.com/theirstory/ts-aligner),
 * Apache License 2.0, © TheirStory contributors; modified. The banded
 * alignment and greedy fallback in particular originate there (v0.2.2).
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
 * PROBLEM STATEMENT:
 * - Machine transcription (e.g., from speech-to-video) produces word-level timings
 *   but often contains transcription errors (wrong words, missing words, extra words)
 * - Human editors correct the transcript text but lose the timing data
 * - We need to transfer timing data from machine transcript to corrected transcript
 * 
 * SOLUTION OVERVIEW:
 * Use edit distance (Levenshtein distance) algorithm to align the two transcripts
 * word-by-word, then transfer timings based on the alignment.
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
 * PLAIN TEXT FORMAT (for corrected transcripts):
 * [Alice]: I believe we should...
 * Bob: Yes, I agree completely.
 * Dr. Johnson: Excellent point.
 * Smith-Jones: Let me add something.
 * - Paragraphs separated by one or more newlines
 * - Optional speaker labels (bracketed or unbracketed)
 * - Colon (:) used as separator for unbracketed speakers
 * - Names can contain periods and dashes (Dr. Johnson, Smith-Jones)
 * - Speaker text must start with capital letter
 * 
 * ALGORITHM FLOW:
 * 
 * 1. EXTRACT phase:
 *    - Parse machine JSON to extract words and timings
 *    - Parse corrected text to extract words (without speaker labels)
 *    
 * 2. ALIGN phase:
 *    - Use dynamic programming edit distance to align word sequences
 *    - Identify matches, substitutions, insertions, deletions
 *    
 * 3. TRANSFER phase:
 *    - For matched/substituted words: use original timing
 *    - For inserted words: interpolate timing from nearby words
 *    - For deleted words: skip (don't appear in output)
 *    
 * 4. RECONSTRUCT phase:
 *    - Detect paragraph structure from corrected text
 *    - Generate JSON with proper structure
 *    - Attach timing data to each word
 * 
 * KEY FEATURES:
 * - Handles word substitutions (corrections)
 * - Handles insertions (words added by editor)
 * - Handles deletions (words removed by editor)
 * - Preserves paragraph structure
 * - Preserves speaker labels
 * - Case-insensitive word matching
 * - Punctuation-aware alignment
 * 
 * LIMITATIONS:
 * - Inserted words borrow timing from adjacent words (not perfectly accurate)
 * - Large-scale restructuring may not align well
 * - Assumes words are mostly in the same order
 * 
 * ============================================================================
 */

/**
 * HELPER FUNCTION: stripPunctuation
 * 
 * PURPOSE: Remove trailing punctuation from a word for better matching
 * 
 * WHY: Machine transcripts and corrected transcripts may differ in punctuation.
 *      "hello," and "hello" should be considered the same word for alignment.
 * 
 * INPUTS:
 *   - word: A string representing a single word (may have punctuation)
 * 
 * OUTPUTS:
 *   - The word with trailing punctuation removed
 * 
 * EXAMPLES:
 *   stripPunctuation("hello,") → "hello"
 *   stripPunctuation("world!") → "world"
 *   stripPunctuation("okay.") → "okay"
 */
function stripPunctuation(word) {
  // Strip punctuation from BOTH edges, including the typographic characters
  // real transcripts carry (curly quotes, ellipses, dashes, brackets). Interior
  // characters stay, so "don't" and "co-op" keep their identity — only the
  // word's edges are dressing. (#425: the old version stripped ASCII trailing
  // punctuation only, so “quoted” words and (parenthesised) ones never
  // matched their plain forms.)
  return word.replace(/^[\s.,!?;:'"“”‘’()\[\]«»…—–-]+|[\s.,!?;:'"“”‘’()\[\]«»…—–-]+$/g, '');
}

/**
 * HELPER FUNCTION: normalizeWord
 * 
 * PURPOSE: Normalize a word for comparison during alignment
 * 
 * WHY: Words should match regardless of case or punctuation differences.
 *      "Hello," and "hello" should be treated as the same word.
 * 
 * INPUTS:
 *   - word: A string representing a single word
 * 
 * OUTPUTS:
 *   - Lowercase word with trailing punctuation removed
 * 
 * PROCESS:
 *   1. Strip trailing punctuation
 *   2. Convert to lowercase
 * 
 * EXAMPLES:
 *   normalizeWord("Hello,") → "hello"
 *   normalizeWord("WORLD!") → "world"
 */
function normalizeWord(word) {
  return stripPunctuation(word.toLowerCase());
}

/**
 * FUNCTION: extractWordsFromJSON
 * 
 * PURPOSE: Extract words and timing data from JSON transcript
 * 
 * INPUTS:
 *   - jsonData: JSON object with structure {words: [...], paragraphs: [...]}
 * 
 * OUTPUTS:
 *   - Object containing:
 *     * words: Array of word text strings
 *     * timings: Array of timing objects {start, end} in seconds
 * 
 * PROCESS:
 *   1. Extract word text from JSON words array
 *   2. Extract timing information (already in seconds)
 *   3. Filter out empty words
 */
function extractWordsFromJSON(jsonData) {
  const words = [];
  const timings = [];
  
  // Process each word in the JSON data
  (jsonData.words || []).forEach(word => {
    // Skip empty words
    if (word.text && word.text.trim()) {
      words.push(word.text.trim());
      
      // Store timing in seconds (as provided in JSON)
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
 * 
 * PURPOSE: Extract just the words from corrected transcript, excluding speaker labels
 * 
 * WHY: We need a clean word array for alignment that matches the structure
 *      of the machine transcript. Speaker labels are metadata, not actual spoken words.
 * 
 * INPUTS:
 *   - plainText: Corrected transcript as plain text (may include speaker labels)
 * 
 * OUTPUTS:
 *   - Array of words (strings) without any speaker labels
 * 
 * EXAMPLE INPUT:
 *   "[Alice]: Hello there.\nBob - How are you?"
 * 
 * EXAMPLE OUTPUT:
 *   ["Hello", "there.", "How", "are", "you?"]
 *   // Note: "Alice" and "Bob" are NOT included
 * 
 * PROCESS:
 *   1. Split text by one or more newlines to get paragraphs
 *   2. For each paragraph:
 *      a. Validate and remove speaker label if present (bracketed or unbracketed)
 *      b. Split remaining text into words
 *   3. Concatenate all words into a single array
 */
function extractWordsFromPlainText(plainText) {
  // Split by one or more newlines to get individual paragraphs
  const paragraphs = plainText.split(/\n+/);
  
  // Accumulator for all words across all paragraphs
  let allWords = [];
  
  // Process each paragraph
  paragraphs.forEach(paragraph => {
    const trimmedParagraph = paragraph.trim();
    
    if (trimmedParagraph.length > 0) {
      // Use the validation function to check for speaker and get remaining text
      const validation = isValidSpeakerPattern(trimmedParagraph);
      
      let paragraphText = trimmedParagraph;
      
      // If valid speaker pattern detected, use the remaining text
      if (validation.isValid) {
        paragraphText = validation.remainingText;
      }
      
      // Split into words by whitespace, filter out empty strings
      const words = paragraphText.split(/\s+/).filter(w => w.length > 0);
      
      // Add this paragraph's words to the master list
      allWords = allWords.concat(words);
    }
  });
  
  return allWords;
}

/**
 * HELPER FUNCTION: isValidSpeakerPattern
 * 
 * PURPOSE: Validate that a potential speaker label follows the correct pattern
 * 
 * WHY: We need to distinguish actual speaker labels from regular text.
 *      Valid patterns:
 *      - [Name]: Hello (bracketed, optionally with colon)
 *      - [Name] Hello (bracketed without colon)
 *      - Name: Hello (unbracketed with colon - required)
 * 
 * INPUTS:
 *   - text: The paragraph text to check
 * 
 * OUTPUTS:
 *   - Object with {isValid: boolean, speaker: string|null, remainingText: string}
 * 
 * VALIDATION RULES:
 *   1. Bracketed: [Name] optionally followed by :, then capitalized word
 *   2. Unbracketed: Capitalized word(s) followed by : (required), then capitalized word
 *   3. Names can contain periods (Dr. Johnson) and dashes (Smith-Jones)
 *   4. Single-letter speakers supported (Q:, A:, I:, etc.)
 *   5. Only : is used as separator (dashes are NOT used as separators)
 * 
 * EXAMPLES:
 *   "[Alice]: Hello there" → {isValid: true, speaker: "Alice"}
 *   "[Bob] Hello" → {isValid: true, speaker: "Bob"}
 *   "Alice: So do I." → {isValid: true, speaker: "Alice"}
 *   "Q: Tell me more." → {isValid: true, speaker: "Q"}
 *   "A: My answer is..." → {isValid: true, speaker: "A"}
 *   "Dr. Johnson: Good morning" → {isValid: true, speaker: "Dr. Johnson"}
 *   "Smith-Jones: Hello" → {isValid: true, speaker: "Smith-Jones"}
 *   "Bob - Hello" → {isValid: false} (dash not used as separator)
 *   "[note] something" → {isValid: false} (lowercase after bracket)
 *   "hello: world" → {isValid: false} (lowercase speaker name)
 */
function isValidSpeakerPattern(text) {
  // Bracketed pattern: [anything] optional(:) then content. Brackets are an
  // explicit statement of intent, so the label and the following text can be
  // ANY script — the old rule required the content to start with [A-Z0-9],
  // which rejected every non-Latin transcript outright (#425).
  const bracketedMatch = text.match(/^\[([^\]]+)\]\s*:?\s*(.+)$/);
  if (bracketedMatch) {
    return {
      isValid: true,
      speaker: bracketedMatch[1].trim(),
      remainingText: bracketedMatch[2]
    };
  }

  // Unbracketed pattern: label followed by ':' and content. No case rules
  // (they were Latin-only too); instead the label is bounded — at most six
  // words and sixty characters, no sentence punctuation — so a sentence that
  // merely CONTAINS a colon is not mistaken for a speaker.
  // Whitespace after the colon is REQUIRED here: without it, times of day
  // ("at 3:30") parse as a speaker called "at 3". "Alice:hello" with no space
  // loses out, but clock times are far commoner in transcripts than unspaced
  // labels.
  const unbracketedMatch = text.match(/^([^:\n]{1,60}?):\s+(.+)$/);
  if (unbracketedMatch) {
    const label = unbracketedMatch[1].trim();
    const wordCount = label.split(/\s+/).filter(Boolean).length;
    if (label.length > 0 && wordCount <= 6 && !/[.!?]{2,}|[,;]/.test(label)) {
      return {
        isValid: true,
        speaker: label,
        remainingText: unbracketedMatch[2]
      };
    }
  }

  return { isValid: false, speaker: null, remainingText: text };
}

/**
 * FUNCTION: detectParagraphs
 * 
 * PURPOSE: Analyze corrected transcript text to identify paragraph boundaries and speakers
 * 
 * WHY: The corrected transcript may have multiple paragraphs and speaker changes.
 *      We need to preserve this structure in the final aligned JSON output.
 * 
 * INPUT FORMAT:
 *   Plain text with:
 *   - Paragraphs separated by one or more newlines
 *   - Optional speaker labels:
 *     * Bracketed: "[Name]: text" or "[Name] text"
 *     * Unbracketed: "Name: text" (colon required)
 *   - Names can contain periods and dashes (Dr. Johnson, Smith-Jones)
 *   - Speaker validation: text after separator must start with capital letter
 * 
 * INPUTS:
 *   - plainText: The corrected transcript as a plain text string
 * 
 * OUTPUTS:
 *   - Array of paragraph metadata objects, each containing:
 *     * paragraphIndex: Index of this paragraph (0, 1, 2, ...)
 *     * startWordIndex: Global word index where this paragraph starts
 *     * endWordIndex: Global word index where this paragraph ends
 *     * wordCount: Number of words in this paragraph
 *     * speaker: Speaker name (null if no valid speaker label)
 * 
 * EXAMPLE INPUT:
 *   "[Alice]: Hello there. How are you?\nBob: I'm doing well, thanks!"
 * 
 * EXAMPLE OUTPUT:
 *   [
 *     {
 *       paragraphIndex: 0,
 *       startWordIndex: 0,
 *       endWordIndex: 5,
 *       wordCount: 6,
 *       speaker: "Alice"
 *     },
 *     {
 *       paragraphIndex: 1,
 *       startWordIndex: 6,
 *       endWordIndex: 10,
 *       wordCount: 5,
 *       speaker: "Bob"
 *     }
 *   ]
 * 
 * PROCESS:
 *   1. Split text by one or more newlines to get paragraphs
 *   2. For each paragraph:
 *      a. Validate speaker label pattern
 *      b. Extract speaker name if valid
 *      c. Remove speaker label from paragraph text
 *      d. Count words in paragraph (excluding speaker label)
 *      e. Track cumulative word index across all paragraphs
 *   3. Return array of paragraph metadata for JSON generation
 */
function detectParagraphs(plainText) {
  // Split by one or more newlines (paragraph separator in plain text)
  const paragraphs = plainText.split(/\n+/);
  
  // Array to store metadata about each paragraph
  const paragraphMap = [];
  
  // Track the cumulative word index across all paragraphs
  let wordIndex = 0;
  
  // Process each paragraph
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const trimmedParagraph = paragraph.trim();
    
    // Skip empty paragraphs
    if (trimmedParagraph.length > 0) {
      // Check if paragraph has a valid speaker pattern
      const validation = isValidSpeakerPattern(trimmedParagraph);
      
      let speaker = null;
      let paragraphText = trimmedParagraph;
      
      if (validation.isValid) {
        speaker = validation.speaker;
        paragraphText = validation.remainingText;
      }
      
      // Split paragraph text into words (by whitespace)
      const paragraphWords = paragraphText.split(/\s+/).filter(w => w.length > 0);
      
      // Only add to map if paragraph has actual words
      if (paragraphWords.length > 0) {
        paragraphMap.push({
          paragraphIndex: paragraphIndex,
          startWordIndex: wordIndex,
          endWordIndex: wordIndex + paragraphWords.length - 1,
          wordCount: paragraphWords.length,
          speaker: speaker
        });
        
        // Move word index forward for next paragraph
        wordIndex += paragraphWords.length;
      }
    }
  });
  
  return paragraphMap;
}

/**
 * FUNCTION: alignWords
 * 
 * PURPOSE: Align two sequences of words using edit distance (Levenshtein distance) algorithm
 * 
 * WHY: Machine transcripts contain errors (wrong words, missing words, extra words).
 *      We need to map each word in the corrected transcript to a word in the 
 *      machine transcript (or mark it as inserted/deleted) to transfer timing data.
 * 
 * ALGORITHM: Dynamic Programming Edit Distance with Backtracking
 * 
 * INPUTS:
 *   - sourceWords: Array of words from the machine transcript (has timings)
 *   - targetWords: Array of words from the corrected transcript (needs timings)
 * 
 * OUTPUTS:
 *   - Array of alignment objects, each describing the relationship between words:
 *     * {type: 'match', sourceIdx, targetIdx} - Words are the same
 *     * {type: 'substitute', sourceIdx, targetIdx} - Words are different (one replaces another)
 *     * {type: 'insert', sourceIdx: null, targetIdx} - Word added in corrected transcript
 *     * {type: 'delete', sourceIdx, targetIdx: null} - Word removed from machine transcript
 * 
 * PROCESS:
 *   PHASE 1: BUILD DP TABLE
 *     - Create a 2D table where dp[i][j] = minimum edits to align first i source words 
 *       with first j target words
 *     - Base cases: dp[i][0] = i (delete all), dp[0][j] = j (insert all)
 *     - For each cell, choose minimum cost operation:
 *       * If words match: dp[i-1][j-1] (no cost)
 *       * Otherwise: min of substitute, delete, or insert (each costs 1)
 * 
 *   PHASE 2: BACKTRACK TO FIND ALIGNMENT
 *     - Start at dp[m][n] (bottom-right corner)
 *     - Work backwards to dp[0][0], recording which operation was used
 *     - Build alignment array showing how words correspond
 * 
 * EXAMPLE:
 *   sourceWords: ["I", "think", "we", "should"]
 *   targetWords: ["I", "believe", "we", "must"]
 *   
 *   Result: [
 *     {type: 'match', sourceIdx: 0, targetIdx: 0},      // "I" matches "I"
 *     {type: 'substitute', sourceIdx: 1, targetIdx: 1}, // "think" → "believe"
 *     {type: 'match', sourceIdx: 2, targetIdx: 2},      // "we" matches "we"
 *     {type: 'substitute', sourceIdx: 3, targetIdx: 3}  // "should" → "must"
 *   ]
 */
function alignWords(sourceWords, targetWords) {
  const m = sourceWords.length;
  const n = targetWords.length;

  // Full-table DP is exact but O(m*n): at 10M cells (Uint32Array, ~40MB) we
  // switch to banded alignment. The band bound matters because this runs in
  // the EDITOR'S tab, alongside the media and the transcript DOM — ts-aligner
  // (whose v0.2.2 this rework is informed by) uses a 4000-word band sized for
  // a dedicated bulk tool, which costs ~2GB; a corrected transcript tracks
  // its machine original closely by nature, so a 1000-word cumulative-drift
  // band is generous here at a tenth of the memory.
  const FULL_TABLE_CELL_LIMIT = 10000000;
  const BANDWIDTH = 1000;

  if (m * n <= FULL_TABLE_CELL_LIMIT) {
    return alignWordsStandard(sourceWords, targetWords);
  }
  return alignWordsBanded(sourceWords, targetWords, BANDWIDTH);
}

/**
 * Exact DP over the full table, as a flat Uint32Array (4 bytes/cell, no
 * per-row array objects).
 *
 * Words are compared NORMALIZED (#425): "recording." must match "recording",
 * or every punctuation difference counts as a substitution and drags the
 * whole alignment sideways. Normalization is precomputed once per word — in
 * the inner loop it would run m*n times.
 *
 * Substitution costs 2 (a delete plus an insert) while insert and delete cost
 * 1 each, so the algorithm prefers to keep exact matches anchored rather than
 * substitute through one and hand its timing to the wrong word.
 */
function alignWordsStandard(sourceWords, targetWords) {
  const m = sourceWords.length;
  const n = targetWords.length;
  const src = sourceWords.map(normalizeWord);
  const tgt = targetWords.map(normalizeWord);

  const width = n + 1;
  const dp = new Uint32Array((m + 1) * width);
  for (let i = 0; i <= m; i++) dp[i * width] = i;
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    const row = i * width;
    const prev = row - width;
    for (let j = 1; j <= n; j++) {
      if (src[i - 1] === tgt[j - 1]) {
        dp[row + j] = dp[prev + j - 1];
      } else {
        dp[row + j] = Math.min(
          dp[prev + j - 1] + 2,  // substitute
          dp[prev + j] + 1,      // delete
          dp[row + j - 1] + 1    // insert
        );
      }
    }
  }

  // Backtrack from the corner, reading the same costs the fill used.
  const alignment = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i === 0) {
      alignment.push({ type: 'insert', sourceIdx: null, targetIdx: j - 1 });
      j--;
    } else if (j === 0) {
      alignment.push({ type: 'delete', sourceIdx: i - 1, targetIdx: null });
      i--;
    } else if (src[i - 1] === tgt[j - 1]) {
      alignment.push({ type: 'match', sourceIdx: i - 1, targetIdx: j - 1 });
      i--; j--;
    } else {
      const here = dp[i * width + j];
      if (here === dp[(i - 1) * width + j - 1] + 2) {
        alignment.push({ type: 'substitute', sourceIdx: i - 1, targetIdx: j - 1 });
        i--; j--;
      } else if (here === dp[(i - 1) * width + j] + 1) {
        alignment.push({ type: 'delete', sourceIdx: i - 1, targetIdx: null });
        i--;
      } else {
        alignment.push({ type: 'insert', sourceIdx: null, targetIdx: j - 1 });
        j--;
      }
    }
  }
  alignment.reverse();
  return alignment;
}

/**
 * Banded alignment for inputs too large for the full table: only cells within
 * `bandwidth` of the (scaled) diagonal are computed, on the observation that a
 * corrected transcript never wanders far from its machine original. Memory is
 * O(m * bandwidth) at 5 bytes per cell (Uint32 cost + Uint8 backtrack).
 * If the corner proves unreachable — drift beyond the band — the greedy
 * fallback still produces a usable alignment rather than nothing.
 */
function alignWordsBanded(sourceWords, targetWords, bandwidth) {
  const m = sourceWords.length;
  const n = targetWords.length;
  if (m === 0) return targetWords.map((_, j) => ({ type: 'insert', sourceIdx: null, targetIdx: j }));
  if (n === 0) return sourceWords.map((_, i) => ({ type: 'delete', sourceIdx: i, targetIdx: null }));

  const src = sourceWords.map(normalizeWord);
  const tgt = targetWords.map(normalizeWord);

  // the band must at least cover the sequences' length difference
  const effectiveBandwidth = Math.max(bandwidth, Math.abs(m - n) + 50);
  const bandWidth = 2 * effectiveBandwidth + 1;

  const INF = 0xFFFFFFFF;
  const NONE = 0, MATCH = 1, SUB = 2, DEL = 3, INS = 4;
  const costs = new Uint32Array((m + 1) * bandWidth).fill(INF);
  const backs = new Uint8Array((m + 1) * bandWidth);

  const diagOf = (i) => Math.round(i * n / m);
  const idxOf = (i, j) => {
    const offset = j - diagOf(i) + effectiveBandwidth;
    if (offset < 0 || offset >= bandWidth) return -1;
    return i * bandWidth + offset;
  };
  const costAt = (i, j) => {
    if (i < 0 || j < 0 || j > n) return INF;
    const k = idxOf(i, j);
    return k < 0 ? INF : costs[k];
  };

  for (let j = 0; j <= n; j++) {
    const k = idxOf(0, j);
    if (k >= 0) { costs[k] = j; backs[k] = j > 0 ? INS : NONE; }
  }

  for (let i = 1; i <= m; i++) {
    const diag = diagOf(i);
    const minJ = Math.max(0, diag - effectiveBandwidth);
    const maxJ = Math.min(n, diag + effectiveBandwidth);
    for (let j = minJ; j <= maxJ; j++) {
      const k = idxOf(i, j);
      if (k < 0) continue;
      if (j === 0) {
        costs[k] = i;
        backs[k] = DEL;
        continue;
      }
      const isMatch = src[i - 1] === tgt[j - 1];
      let best = costAt(i - 1, j - 1) + (isMatch ? 0 : 2);
      let back = isMatch ? MATCH : SUB;
      const del = costAt(i - 1, j) + 1;
      if (del < best) { best = del; back = DEL; }
      const ins = costAt(i, j - 1) + 1;
      if (ins < best) { best = ins; back = INS; }
      costs[k] = best;
      backs[k] = back;
    }
  }

  const endIdx = idxOf(m, n);
  if (endIdx < 0 || costs[endIdx] === INF) {
    console.warn('word-alignment: drift exceeded the band — using greedy fallback');
    return alignWordsGreedy(src, tgt);
  }

  const alignment = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i === 0) { alignment.push({ type: 'insert', sourceIdx: null, targetIdx: j - 1 }); j--; continue; }
    if (j === 0) { alignment.push({ type: 'delete', sourceIdx: i - 1, targetIdx: null }); i--; continue; }
    switch (backs[idxOf(i, j)]) {
      case MATCH: alignment.push({ type: 'match', sourceIdx: i - 1, targetIdx: j - 1 }); i--; j--; break;
      case SUB: alignment.push({ type: 'substitute', sourceIdx: i - 1, targetIdx: j - 1 }); i--; j--; break;
      case DEL: alignment.push({ type: 'delete', sourceIdx: i - 1, targetIdx: null }); i--; break;
      case INS: alignment.push({ type: 'insert', sourceIdx: null, targetIdx: j - 1 }); j--; break;
      default: i--; j--; // unreachable given a valid fill; never loop forever
    }
  }
  alignment.reverse();
  return alignment;
}

/**
 * Greedy fallback when even the band cannot reach the corner: walk both
 * sequences, looking ahead a window for the next agreement. Not optimal, but
 * always terminates with a usable alignment. Receives NORMALIZED words.
 */
function alignWordsGreedy(src, tgt) {
  const alignment = [];
  const m = src.length;
  const n = tgt.length;
  const LOOKAHEAD = 50;

  let i = 0, j = 0;
  while (i < m && j < n) {
    if (src[i] === tgt[j]) {
      alignment.push({ type: 'match', sourceIdx: i, targetIdx: j });
      i++; j++;
      continue;
    }
    let foundInTarget = -1;
    for (let k = j + 1; k < Math.min(j + LOOKAHEAD, n); k++) {
      if (src[i] === tgt[k]) { foundInTarget = k; break; }
    }
    let foundInSource = -1;
    for (let k = i + 1; k < Math.min(i + LOOKAHEAD, m); k++) {
      if (src[k] === tgt[j]) { foundInSource = k; break; }
    }
    if (foundInTarget >= 0 && (foundInSource < 0 || foundInTarget - j <= foundInSource - i)) {
      while (j < foundInTarget) { alignment.push({ type: 'insert', sourceIdx: null, targetIdx: j }); j++; }
    } else if (foundInSource >= 0) {
      while (i < foundInSource) { alignment.push({ type: 'delete', sourceIdx: i, targetIdx: null }); i++; }
    } else {
      alignment.push({ type: 'substitute', sourceIdx: i, targetIdx: j });
      i++; j++;
    }
  }
  while (i < m) { alignment.push({ type: 'delete', sourceIdx: i, targetIdx: null }); i++; }
  while (j < n) { alignment.push({ type: 'insert', sourceIdx: null, targetIdx: j }); j++; }
  return alignment;
}

/**
 * FUNCTION: generateAlignedJSON
 * 
 * PURPOSE: Generate JSON output with aligned timings and paragraph structure
 * 
 * WHY: This is the final step that combines:
 *      1. Corrected transcript words (from human editor)
 *      2. Timing data (from machine transcript)
 *      3. Paragraph structure and speakers (from corrected transcript)
 *      to produce a perfectly timed, correctly worded, well-structured JSON transcript
 * 
 * INPUTS:
 *   - alignment: Array of alignment objects from alignWords() function
 *   - sourceWords: Words from machine transcript (have timings)
 *   - targetWords: Words from corrected transcript (need timings)
 *   - timings: Timing data from machine transcript (in seconds)
 *   - plainText: Corrected transcript as plain text (for paragraph structure)
 * 
 * OUTPUTS:
 *   - JSON object with structure:
 *     {
 *       words: [{start, end, text}, ...],
 *       paragraphs: [{speaker, start, end}, ...]
 *     }
 * 
 * PROCESS:
 *   PHASE 1: Build output array with words and timings
 *     - For each aligned word:
 *       * If MATCH or SUBSTITUTE: Use timing from source word
 *       * If INSERT: Interpolate timing (use next/previous timing)
 *       * If DELETE: Skip (word doesn't appear in output)
 *   
 *   PHASE 2: Detect paragraph structure from plain text
 *   
 *   PHASE 3: Generate JSON with proper paragraph structure
 */
function generateAlignedJSON(alignment, sourceWords, targetWords, timings, plainText) {
  // ===== PHASE 1: BUILD OUTPUT ARRAY WITH WORDS AND TIMINGS =====
  
  // Words that matched (or substituted) take their machine timing directly
  // and act as ANCHORS. Inserted words are collected into runs and their
  // timing DISTRIBUTED across the gap between the surrounding anchors (#425)
  // — the old behaviour gave every inserted word the next anchor's timing
  // verbatim, so a run of insertions collapsed onto identical timestamps:
  // zero-duration words, overlapping cues, and highlighting that jumped.
  //
  // The distribution is weighted by syllable estimate — contiguous vowel
  // groups, the same heuristic the editor's word-split feature uses — so a
  // long word takes a proportionally longer span of the silence.
  const outputWords = [];

  const syllableWeight = (word) => {
    const groups = String(word).toLowerCase().match(/[aeiouyàáâäåèéêëìíîïòóôöùúûüæø]+/g);
    return groups && groups.length > 0 ? groups.length : 1;
  };

  // Nominal per-word duration for runs with an open end (before the first
  // anchor, after the last, or a transcript with no anchors at all).
  const NOMINAL_WORD_SECONDS = 0.25;

  const distributeRun = (words, startTime, endTime) => {
    const span = Math.max(0, endTime - startTime);
    const weights = words.map((w) => syllableWeight(w.word));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let cursor = startTime;
    words.forEach((w, k) => {
      // the last word absorbs the rounding remainder, keeping the run flush
      const share = k === words.length - 1
        ? (startTime + span) - cursor
        : span * (weights[k] / totalWeight);
      w.start = cursor;
      w.end = cursor + share;
      cursor = w.end;
    });
  };

  let pendingRun = [];
  let lastTiming = null;

  const flushRun = (nextTiming) => {
    if (pendingRun.length === 0) return;
    if (lastTiming !== null && nextTiming !== null) {
      // between two anchors: share out the silence between them
      distributeRun(pendingRun, lastTiming.end, Math.max(lastTiming.end, nextTiming.start));
    } else if (nextTiming !== null) {
      // before the first anchor: back-fill toward it, clamped at zero
      const total = Math.min(nextTiming.start, pendingRun.length * NOMINAL_WORD_SECONDS);
      distributeRun(pendingRun, Math.max(0, nextTiming.start - total), nextTiming.start);
    } else if (lastTiming !== null) {
      // after the last anchor: run on at nominal pace
      distributeRun(pendingRun, lastTiming.end,
        lastTiming.end + pendingRun.length * NOMINAL_WORD_SECONDS);
    } else {
      // no anchors anywhere: a transcript with no matches at all
      distributeRun(pendingRun, 0, pendingRun.length * NOMINAL_WORD_SECONDS);
    }
    pendingRun = [];
  };

  alignment.forEach((align) => {
    if (align.type === 'match' || align.type === 'substitute') {
      const timing = timings[align.sourceIdx];
      flushRun(timing);
      outputWords.push({
        word: targetWords[align.targetIdx],
        start: timing.start,
        end: timing.end,
        targetIdx: align.targetIdx
      });
      lastTiming = timing;
    } else if (align.type === 'insert') {
      const placeholder = {
        word: targetWords[align.targetIdx],
        start: 0,
        end: 0,
        targetIdx: align.targetIdx
      };
      outputWords.push(placeholder); // position holds; times filled at flush
      pendingRun.push(placeholder);
    }
    // 'delete': the machine word has no counterpart in the corrected text —
    // it simply does not appear in the output
  });
  flushRun(null);

  // ===== PHASE 2: DETECT PARAGRAPH STRUCTURE =====
  // Analyze the plain text to find paragraph boundaries and speaker labels
  const paragraphMap = detectParagraphs(plainText);
  
  // ===== PHASE 3: BUILD JSON OUTPUT =====
  
  // Convert words to JSON format
  const jsonWords = outputWords.map(item => ({
    start: item.start,  // Already in seconds
    end: item.end,      // Already in seconds
    text: item.word
  }));
  
  // Build paragraphs array
  const jsonParagraphs = [];
  
  if (paragraphMap.length > 0) {
    // MULTI-PARAGRAPH CASE: Create paragraph objects based on detected structure
    paragraphMap.forEach(paragraph => {
      // Find words in this paragraph
      const paragraphWords = outputWords.filter(item =>
        item.targetIdx >= paragraph.startWordIndex &&
        item.targetIdx <= paragraph.endWordIndex
      );
      
      if (paragraphWords.length > 0) {
        // Get start time from first word, end time from last word
        const firstWord = paragraphWords[0];
        const lastWord = paragraphWords[paragraphWords.length - 1];
        
        const paragraphObj = {
          start: firstWord.start,  // In seconds
          end: lastWord.end        // In seconds
        };
        
        // Add speaker if present (without brackets or punctuation)
        if (paragraph.speaker) {
          paragraphObj.speaker = paragraph.speaker;
        }
        
        jsonParagraphs.push(paragraphObj);
      }
    });
  } else {
    // SINGLE PARAGRAPH FALLBACK: No paragraph breaks detected
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
 * ============================================================================
 * MAIN API FUNCTION
 * ============================================================================
 */

/**
 * FUNCTION: alignTranscripts
 * 
 * PURPOSE: Main entry point for transcript alignment using JSON format
 * 
 * WHY: Provides a simple, high-level API for aligning transcripts.
 *      This is the main function users will call.
 * 
 * INPUTS:
 *   - machineTranscript: JSON object from machine transcript (has timings)
 *     Format: {words: [{start, end, text}, ...], paragraphs: [...]}
 *   - correctedText: Plain text of corrected transcript
 *     Format: "[Speaker]: text\nSpeaker: more text"
 * 
 * OUTPUTS:
 *   - JSON object with corrected words and aligned timings
 *     Format: {words: [{start, end, text}, ...], paragraphs: [...]}
 * 
 * EXAMPLE USAGE:
 *   const machineJSON = {
 *     words: [{start: 4.76, end: 5.28, text: "Testing"}, ...],
 *     paragraphs: [{speaker: "Alice", start: 4.76, end: 10.0}]
 *   };
 *   const correctedText = "[Alice]: Testing the production version...";
 *   const alignedJSON = alignTranscripts(machineJSON, correctedText);
 * 
 * ALGORITHM STEPS:
 *   1. Extract words and timings from machine JSON
 *   2. Extract words from corrected plain text
 *   3. Align the two word sequences using edit distance
 *   4. Generate aligned JSON output with timing and structure
 */
function alignTranscripts(machineTranscript, correctedText) {
  // Step 1: Extract words and timings from machine JSON
  const { words: sourceWords, timings } = extractWordsFromJSON(machineTranscript);
  
  // Step 2: Extract words from corrected text (without speaker labels)
  const targetWords = extractWordsFromPlainText(correctedText);
  
  // Step 3: Align the two word sequences
  const alignment = alignWords(sourceWords, targetWords);
  
  // Step 4: Generate aligned JSON output
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
 * ============================================================================
 * EXPORTS (for module usage)
 * ============================================================================
 */

// Export main API function
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    alignTranscripts,
    // Export internal functions for advanced usage
    extractWordsFromJSON,
    extractWordsFromPlainText,
    detectParagraphs,
    alignWords,
    alignWordsStandard,
    alignWordsBanded,
    alignWordsGreedy,
    generateAlignedJSON,
    // Export helpers
    stripPunctuation,
    normalizeWord,
    isValidSpeakerPattern
  };
}
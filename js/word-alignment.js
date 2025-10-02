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
 * [Alice] I believe we should...
 * 
 * [Bob] Yes, I agree completely.
 * - Paragraphs separated by double newlines
 * - Optional speaker labels in square brackets
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
  // Remove one or more trailing punctuation characters: .,!?;:'"
  // The + means "one or more", $ means "at the end of string"
  return word.replace(/[.,!?;:'"]+$/, '');
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
 *   "[Alice] Hello there.\n\n[Bob] How are you?"
 * 
 * EXAMPLE OUTPUT:
 *   ["Hello", "there.", "How", "are", "you?"]
 *   // Note: "Alice" and "Bob" are NOT included
 * 
 * PROCESS:
 *   1. Split text by double newlines to get paragraphs
 *   2. For each paragraph:
 *      a. Remove speaker label if present (pattern: [Name] at start)
 *      b. Split remaining text into words
 *   3. Concatenate all words into a single array
 */
function extractWordsFromPlainText(plainText) {
  // Split by double newlines to get individual paragraphs
  const paragraphs = plainText.split(/\n\s*\n/);
  
  // Accumulator for all words across all paragraphs
  let allWords = [];
  
  // Process each paragraph
  paragraphs.forEach(paragraph => {
    const trimmedParagraph = paragraph.trim();
    
    if (trimmedParagraph.length > 0) {
      // Remove speaker name if present at the start
      // Regex: ^\[([^\]]+)\]\s* matches "[Name] " at the beginning
      const paragraphText = trimmedParagraph.replace(/^\[([^\]]+)\]\s*/, '');
      
      // Split into words by whitespace, filter out empty strings
      const words = paragraphText.split(/\s+/).filter(w => w.length > 0);
      
      // Add this paragraph's words to the master list
      allWords = allWords.concat(words);
    }
  });
  
  return allWords;
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
 *   - Paragraphs separated by double newlines (\n\n)
 *   - Optional speaker labels in square brackets at start of paragraph: "[Name] text"
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
 *     * speaker: Speaker name (null if no speaker label)
 * 
 * EXAMPLE INPUT:
 *   "[Alice] Hello there. How are you?\n\n[Bob] I'm doing well, thanks!"
 * 
 * EXAMPLE OUTPUT:
 *   [
 *     {
 *       paragraphIndex: 0,
 *       startWordIndex: 0,
 *       endWordIndex: 5,    // "Hello there How are you"
 *       wordCount: 6,
 *       speaker: "Alice"
 *     },
 *     {
 *       paragraphIndex: 1,
 *       startWordIndex: 6,
 *       endWordIndex: 10,   // "I'm doing well thanks"
 *       wordCount: 5,
 *       speaker: "Bob"
 *     }
 *   ]
 * 
 * PROCESS:
 *   1. Split text by double newlines to get paragraphs
 *   2. For each paragraph:
 *      a. Check for speaker label pattern: [Name] at start
 *      b. Extract speaker name if present
 *      c. Remove speaker label from paragraph text
 *      d. Count words in paragraph (excluding speaker label)
 *      e. Track cumulative word index across all paragraphs
 *   3. Return array of paragraph metadata for JSON generation
 */
function detectParagraphs(plainText) {
  // Split by double newlines (paragraph separator in plain text)
  // Regex: \n\s*\n matches newline, optional whitespace, newline
  const paragraphs = plainText.split(/\n\s*\n/);
  
  // Array to store metadata about each paragraph
  const paragraphMap = [];
  
  // Track the cumulative word index across all paragraphs
  // This helps us map paragraph words to their position in the global word array
  let wordIndex = 0;
  
  // Process each paragraph
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const trimmedParagraph = paragraph.trim();
    
    // Skip empty paragraphs
    if (trimmedParagraph.length > 0) {
      // Check if paragraph starts with a speaker label: [Name]
      // Regex: ^\[([^\]]+)\]\s*
      //   ^          = start of string
      //   \[         = literal opening bracket
      //   ([^\]]+)   = capture group: one or more non-bracket characters (the name)
      //   \]         = literal closing bracket
      //   \s*        = optional whitespace after bracket
      const speakerMatch = trimmedParagraph.match(/^\[([^\]]+)\]\s*/);
      
      let speaker = null;
      let paragraphText = trimmedParagraph;
      
      if (speakerMatch) {
        // Extract speaker name from capture group (without brackets)
        speaker = speakerMatch[1];
        
        // Remove the entire speaker label from the text
        // substring starts after the matched speaker label
        paragraphText = trimmedParagraph.substring(speakerMatch[0].length);
      }
      
      // Split paragraph text into words (by whitespace)
      // Filter out empty strings that might result from multiple spaces
      const paragraphWords = paragraphText.split(/\s+/).filter(w => w.length > 0);
      
      // Only add to map if paragraph has actual words
      if (paragraphWords.length > 0) {
        paragraphMap.push({
          paragraphIndex: paragraphIndex,           // Which paragraph this is (0-based)
          startWordIndex: wordIndex,                // First word index in global array
          endWordIndex: wordIndex + paragraphWords.length - 1,  // Last word index
          wordCount: paragraphWords.length,         // Total words in this paragraph
          speaker: speaker                          // Speaker name or null
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
  const m = sourceWords.length;  // Number of words in machine transcript
  const n = targetWords.length;  // Number of words in corrected transcript
  
  // ===== PHASE 1: BUILD DP TABLE =====
  // Create a 2D table to store minimum edit distances
  // dp[i][j] = minimum number of operations to align sourceWords[0..i-1] with targetWords[0..j-1]
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  // Initialize base cases:
  // dp[i][0] = i: To align i source words with 0 target words, delete all i words
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  
  // dp[0][j] = j: To align 0 source words with j target words, insert all j words
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  // Fill the DP table using dynamic programming
  // For each cell, compute the minimum cost of three possible operations
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      // Check if current words match (case-insensitive comparison)
      if (sourceWords[i-1].toLowerCase() === targetWords[j-1].toLowerCase()) {
        // Words match! No operation needed, inherit cost from diagonal
        dp[i][j] = dp[i-1][j-1];
      } else {
        // Words don't match. Choose the minimum cost operation:
        dp[i][j] = Math.min(
          dp[i-1][j-1] + 1,  // SUBSTITUTE: Replace source word with target word (cost: 1)
          dp[i-1][j] + 1,    // DELETE: Remove source word (cost: 1)
          dp[i][j-1] + 1     // INSERT: Add target word (cost: 1)
        );
      }
    }
  }
  
  // ===== PHASE 2: BACKTRACK TO FIND ALIGNMENT =====
  // Now that we have the minimum edit distance, trace back through the table
  // to find which specific operations were used
  const alignment = [];
  let i = m;  // Start at bottom-right corner (end of source words)
  let j = n;  // Start at bottom-right corner (end of target words)
  
  // Work backwards from dp[m][n] to dp[0][0]
  while (i > 0 || j > 0) {
    if (i === 0) {
      // No more source words left, all remaining target words are insertions
      alignment.push({ type: 'insert', sourceIdx: null, targetIdx: j-1 });
      j--;
    } else if (j === 0) {
      // No more target words left, all remaining source words are deletions
      alignment.push({ type: 'delete', sourceIdx: i-1, targetIdx: null });
      i--;
    } else {
      // Both sequences still have words, determine which operation was used
      const current = dp[i][j];
      
      // Check if words match (this gives us the operation for free)
      if (sourceWords[i-1].toLowerCase() === targetWords[j-1].toLowerCase()) {
        alignment.push({ type: 'match', sourceIdx: i-1, targetIdx: j-1 });
        i--;
        j--;
      } 
      // Check if the current cost came from a substitution (diagonal)
      else if (current === dp[i-1][j-1] + 1) {
        alignment.push({ type: 'substitute', sourceIdx: i-1, targetIdx: j-1 });
        i--;
        j--;
      } 
      // Check if the current cost came from a deletion (move up)
      else if (current === dp[i-1][j] + 1) {
        alignment.push({ type: 'delete', sourceIdx: i-1, targetIdx: null });
        i--;
      } 
      // Otherwise, it must have come from an insertion (move left)
      else {
        alignment.push({ type: 'insert', sourceIdx: null, targetIdx: j-1 });
        j--;
      }
    }
  }
  
  // Reverse the alignment array because we built it backwards
  alignment.reverse();
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
  
  // Array to store final words with their timing information
  // Each element: {word, start, end, targetIdx}
  const outputWords = [];
  
  // Track the most recent timing for interpolation purposes
  let lastTiming = null;
  
  // Process each alignment operation to build the output
  alignment.forEach((align, idx) => {
    
    // CASE 1: MATCH or SUBSTITUTE
    // The target word corresponds to a source word, so we can use its timing directly
    if (align.type === 'match' || align.type === 'substitute') {
      const timing = timings[align.sourceIdx];
      outputWords.push({
        word: targetWords[align.targetIdx],   // Use corrected word text
        start: timing.start,                  // Use machine timing (seconds)
        end: timing.end,                      // Use machine timing (seconds)
        targetIdx: align.targetIdx            // Track position in target array
      });
      lastTiming = timing;  // Remember this for interpolating inserted words
    } 
    
    // CASE 2: INSERT
    // This word was added in the corrected transcript, so it has no direct timing.
    // We need to estimate/interpolate the timing from nearby words.
    else if (align.type === 'insert') {
      // Look ahead in the alignment to find the next word with timing
      let nextTiming = null;
      for (let i = idx + 1; i < alignment.length; i++) {
        if (alignment[i].type === 'match' || alignment[i].type === 'substitute') {
          nextTiming = timings[alignment[i].sourceIdx];
          break;  // Found it, stop searching
        }
      }
      
      // Use the next timing if found, otherwise fall back to the last timing
      // This means inserted words will "borrow" timing from adjacent words
      const timing = nextTiming || lastTiming;
      
      if (timing) {
        outputWords.push({
          word: targetWords[align.targetIdx],
          start: timing.start,    // Borrow start time from nearby word
          end: timing.end,        // Borrow end time from nearby word
          targetIdx: align.targetIdx
        });
      } else {
        // FALLBACK: If no timing available at all (rare edge case)
        // Use dummy timing values so the output is still valid
        outputWords.push({
          word: targetWords[align.targetIdx],
          start: 0,     // Start at beginning
          end: 0.1,     // 100ms duration
          targetIdx: align.targetIdx
        });
      }
    }
    
    // CASE 3: DELETE
    // Word existed in machine transcript but not in corrected transcript
    // We simply skip it - it won't appear in the output at all
    // (No code needed here, just explanation)
  });
  
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
        
        // Add speaker if present
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
 *     Format: "[Speaker] text\n\n[Speaker] more text"
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
 *   const correctedText = "[Alice] Testing the production version...";
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
    generateAlignedJSON,
    // Export helpers
    stripPunctuation,
    normalizeWord
  };
}
/**
 * ============================================================================
 * TRANSCRIPT FORMAT CONVERSION UTILITIES
 * ============================================================================
 * 
 * PURPOSE:
 * Convert between JSON and HTML transcript formats.
 * 
 * WHY SEPARATE FILE:
 * The main alignment algorithm (alignment.js) works entirely with JSON internally.
 * This file provides conversion utilities for legacy HTML format support.
 * 
 * FORMATS:
 * 
 * JSON (Primary format):
 * {
 *   "words": [
 *     {"start": 4.76, "end": 5.28, "text": "word"}
 *   ],
 *   "paragraphs": [
 *     {"speaker": "Name", "start": 4.76, "end": 10.0}
 *   ]
 * }
 * - Times in SECONDS (floating point)
 * 
 * HTML (Legacy format):
 * <article><section>
 *   <p>
 *     <span data-m="4760" data-d="520" class="speaker">[Name] </span>
 *     <span data-m="4760" data-d="520">word </span>
 *   </p>
 * </section></article>
 * - Times in MILLISECONDS (integers)
 * - data-m = start time in milliseconds
 * - data-d = duration in milliseconds
 * 
 * ============================================================================
 */

/**
 * FUNCTION: jsonToHTML
 * 
 * PURPOSE: Convert JSON transcript format to HTML format
 * 
 * WHY: Allows using JSON as the primary data format while still generating
 *      HTML for display/playback in systems that expect HTML.
 * 
 * INPUTS:
 *   - jsonData: JSON object with structure {words: [...], paragraphs: [...]}
 * 
 * OUTPUTS:
 *   - HTML string with <article><section><p> structure and timing spans
 * 
 * TIME CONVERSION:
 *   - JSON uses seconds (e.g., 4.76)
 *   - HTML uses milliseconds (e.g., 4760)
 *   - Formula: milliseconds = Math.round(seconds * 1000)
 * 
 * NOTES:
 *   - If no paragraphs provided, all words go in one paragraph
 *   - Speaker labels are optional
 *   - Empty speaker attribute is preserved as null
 * 
 * EXAMPLE:
 *   Input: {
 *     words: [{start: 4.76, end: 5.28, text: "Testing"}],
 *     paragraphs: [{speaker: "Alice", start: 4.76, end: 5.28}]
 *   }
 *   Output: <article><section><p>
 *     <span data-m="4760" data-d="0" class="speaker">[Alice] </span>
 *     <span data-m="4760" data-d="520">Testing </span>
 *   </p></section></article>
 */
function jsonToHTML(jsonData) {
  const words = jsonData.words || [];
  const paragraphs = jsonData.paragraphs || [];
  
  // Start HTML structure
  let html = '<article><section>\n';
  
  if (paragraphs.length > 0) {
    // ===== MULTI-PARAGRAPH CASE =====
    // Generate separate <p> tags based on paragraph data
    
    paragraphs.forEach((paragraph, paragraphIndex) => {
      html += '  <p>\n';
      
      // Add speaker label if present
      if (paragraph.speaker) {
        // Convert paragraph start time from seconds to milliseconds
        const speakerTime = Math.round(paragraph.start * 1000);
        
        // Speaker span has zero duration (data-d="0")
        html += `    <span data-m="${speakerTime}" data-d="0" class="speaker">[${paragraph.speaker}] </span>\n`;
      }
      
      // Find all words that belong to this paragraph
      // Words belong to a paragraph if their start time is within the paragraph's time range
      const paragraphStart = paragraph.start;
      const paragraphEnd = paragraph.end;
      
      const paragraphWords = words.filter(word => 
        word.start >= paragraphStart && word.start < paragraphEnd
      );
      
      // Generate span for each word
      paragraphWords.forEach(word => {
        // Convert times from seconds to milliseconds
        const startMs = Math.round(word.start * 1000);
        const endMs = Math.round(word.end * 1000);
        const durationMs = endMs - startMs;
        
        // Create span with timing attributes
        html += `    <span data-m="${startMs}" data-d="${durationMs}">${word.text} </span>\n`;
      });
      
      html += '  </p>\n';
    });
    
  } else {
    // ===== SINGLE PARAGRAPH FALLBACK =====
    // No paragraph data, put all words in one <p>
    html += '  <p>\n';
    
    words.forEach(word => {
      // Convert times from seconds to milliseconds
      const startMs = Math.round(word.start * 1000);
      const endMs = Math.round(word.end * 1000);
      const durationMs = endMs - startMs;
      
      html += `    <span data-m="${startMs}" data-d="${durationMs}">${word.text} </span>\n`;
    });
    
    html += '  </p>\n';
  }
  
  html += '</section></article>';
  
  return html;
}

/**
 * FUNCTION: htmlToJSON
 * 
 * PURPOSE: Convert HTML transcript format to JSON format
 * 
 * WHY: JSON is more portable, easier to manipulate, and preferred for
 *      data processing. This allows migrating from legacy HTML format.
 * 
 * INPUTS:
 *   - html: HTML string with timing spans
 * 
 * OUTPUTS:
 *   - JSON object with structure {words: [...], paragraphs: [...]}
 * 
 * TIME CONVERSION:
 *   - HTML uses milliseconds (e.g., 4760)
 *   - JSON uses seconds (e.g., 4.76)
 *   - Formula: seconds = milliseconds / 1000
 * 
 * NOTES:
 *   - Filters out speaker spans from words array (they're metadata)
 *   - Preserves paragraph boundaries from <p> tags
 *   - Extracts speaker labels from speaker spans
 * 
 * PROCESS:
 *   1. Parse HTML into DOM
 *   2. Extract all word spans (excluding speaker spans)
 *   3. Extract paragraph boundaries and speaker labels
 *   4. Convert times to seconds
 *   5. Build JSON object
 * 
 * EXAMPLE:
 *   Input: <article><section><p>
 *     <span data-m="4760" data-d="0" class="speaker">[Alice] </span>
 *     <span data-m="4760" data-d="520">Testing </span>
 *   </p></section></article>
 *   Output: {
 *     words: [{start: 4.76, end: 5.28, text: "Testing"}],
 *     paragraphs: [{speaker: "Alice", start: 4.76, end: 5.28}]
 *   }
 */
function htmlToJSON(html) {
  // Parse HTML into a queryable DOM structure
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  // ===== EXTRACT WORDS =====
  // Find all spans with timing data that are NOT speaker labels
  const words = [];
  const wordSpans = doc.querySelectorAll('span[data-m][data-d]:not(.speaker)');
  
  wordSpans.forEach(span => {
    const text = span.textContent.trim();
    if (text) {
      // Parse timing attributes
      const startMs = parseInt(span.getAttribute('data-m'));
      const durationMs = parseInt(span.getAttribute('data-d'));
      const endMs = startMs + durationMs;
      
      // Convert from milliseconds to seconds
      words.push({
        start: startMs / 1000,
        end: endMs / 1000,
        text: text
      });
    }
  });
  
  // ===== EXTRACT PARAGRAPHS =====
  const paragraphs = [];
  const paragraphElements = doc.querySelectorAll('p');
  
  paragraphElements.forEach(pElement => {
    // Find speaker span if present
    const speakerSpan = pElement.querySelector('span.speaker');
    let speaker = null;
    
    if (speakerSpan) {
      // Extract speaker name from text like "[SPEAKER_S1] "
      const speakerText = speakerSpan.textContent.trim();
      const match = speakerText.match(/^\[([^\]]+)\]/);
      if (match) {
        speaker = match[1];  // Extract name without brackets
      }
    }
    
    // Find all word spans in this paragraph (excluding speaker)
    const paragraphWordSpans = pElement.querySelectorAll('span[data-m][data-d]:not(.speaker)');
    
    if (paragraphWordSpans.length > 0) {
      // Get start time from first word and end time from last word
      const firstSpan = paragraphWordSpans[0];
      const lastSpan = paragraphWordSpans[paragraphWordSpans.length - 1];
      
      const startMs = parseInt(firstSpan.getAttribute('data-m'));
      const lastStartMs = parseInt(lastSpan.getAttribute('data-m'));
      const lastDurationMs = parseInt(lastSpan.getAttribute('data-d'));
      const endMs = lastStartMs + lastDurationMs;
      
      // Create paragraph object
      const paragraph = {
        start: startMs / 1000,  // Convert to seconds
        end: endMs / 1000       // Convert to seconds
      };
      
      // Add speaker if present (speaker is optional)
      if (speaker) {
        paragraph.speaker = speaker;
      }
      
      paragraphs.push(paragraph);
    }
  });
  
  // Return JSON object
  return {
    words: words,
    paragraphs: paragraphs
  };
}

/**
 * ============================================================================
 * EXPORTS (for module usage)
 * ============================================================================
 */

// Export conversion functions
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    jsonToHTML,
    htmlToJSON
  };
}
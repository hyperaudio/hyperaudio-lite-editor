/**
 * search-match.js
 * (C) The Hyperaudio Project
 * @version 1.3.25 — last changed in release 1.3.25
 * @license MIT
 *
 * How the transcript search matches (#395), shared by the search in
 * js/hyperaudio-lite-extension.js and the one-span phrase pass in
 * js/find-replace.js so the two cannot disagree. One rule: WHAT YOU TYPE MUST
 * BE THERE; WHAT YOU DON'T TYPE IS IGNORED.
 *
 *   - Letters match case-insensitively, as a substring of a word: "um" finds
 *     "um", "umbrella" and "album", as you type.
 *   - A space typed before or after the query is a word edge: " um " finds
 *     only the word "um"; "um " words ending in it; " um" words starting with
 *     it. Between the words of a phrase, the edges are always there.
 *   - Punctuation typed must be there: "U.S." finds "U.S." but not "us";
 *     "it's" finds "it's" but not "its". A straight quote also matches a
 *     curly one, which is what some engines write and few keyboards type.
 *   - Punctuation NOT typed is skipped: "um" still finds "um," and "um.";
 *     "speaker2" finds "SPEAKER-2" (#260 upstream). The punctuation around a
 *     match stays outside it.
 *   - A token of punctuation alone belongs to the word before it
 *     ("big , pharma" is "big, pharma"), or the one after at the start.
 *
 * Pure: no DOM. Exported for node tests.
 */
(function () {
  // punctuation and spaces: anything that is not a letter, digit or mark
  const OTHER = /[^\p{L}\p{N}\p{M}]/u;
  const isOther = (ch) => OTHER.test(ch);
  const allOther = (text) => [...text].every(isOther);

  // lower-case and fold quote variants, keeping one character per character
  // so a range found in the result is a range in the original
  const fold = (text) => String(text).split('').map((ch) => {
    const lower = ch.toLowerCase();
    const one = lower.length === 1 ? lower : ch;
    if (one === '’' || one === '‘' || one === 'ʼ') return "'";
    if (one === '“' || one === '”') return '"';
    return one;
  }).join('');

  // { words, leading, trailing }, or null for a query with nothing in it
  function parseQuery(query) {
    const raw = String(query === undefined || query === null ? '' : query);
    const tokens = fold(raw).trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const words = [];
    tokens.forEach((token, i) => {
      if (tokens.length > 1 && allOther(token)) {
        if (words.length > 0) { words[words.length - 1] += token; return; }
        tokens[i + 1] = token + tokens[i + 1];
        return;
      }
      words.push(token);
    });
    return { words, leading: /^\s/.test(raw), trailing: /\s$/.test(raw) };
  }

  // The [start, end) of the first match of `query` in `text`, or null.
  // `atStart` / `atEnd`: the match must begin / finish a word, with nothing but
  // punctuation or space between it and that edge of the text. In `query`, a
  // space stands for a gap between words: one or more spaces in the text, with
  // any punctuation not typed.
  function findIn(text, query, atStart, atEnd) {
    const t = fold(text);
    const q = query;
    if (q.length === 0) return null;
    for (let start = 0; start < t.length; start += 1) {
      if (atStart && !allOther(t.slice(0, start))) break;   // only longer from here
      if (t[start] !== q[0]) continue;
      let ti = start;
      let qi = 0;
      while (ti < t.length && qi < q.length) {
        if (q[qi] === ' ') {
          // a gap: at least one space, plus any punctuation not typed next
          let sawSpace = false;
          while (ti < t.length && isOther(t[ti]) && t[ti] !== q[qi + 1]) {
            if (/\s/.test(t[ti])) sawSpace = true;
            ti += 1;
          }
          if (!sawSpace) break;
          qi += 1;
        } else if (t[ti] === q[qi]) {
          ti += 1;
          qi += 1;
        } else if (isOther(t[ti]) && !/\s/.test(t[ti])) {
          ti += 1;                     // punctuation not typed: skipped
        } else {
          break;
        }
      }
      if (qi < q.length) continue;
      if (atEnd && !allOther(t.slice(ti))) continue;
      return [start, ti];
    }
    return null;
  }

  // Where a parsed query matches across consecutive word texts, one word per
  // text: an array of [start, end) per word, or null.
  function matchAcross(texts, parsed) {
    const n = parsed.words.length;
    if (texts.length < n) return null;
    const ranges = [];
    for (let j = 0; j < n; j += 1) {
      const range = findIn(texts[j], parsed.words[j],
        j === 0 ? parsed.leading : true,
        j === n - 1 ? parsed.trailing : true);
      if (range === null) return null;
      ranges.push(range);
    }
    return ranges;
  }

  // Where a phrase of two or more words matches inside ONE text, such as a
  // speaker label "[Teon Brooks] " (#568): [start, end) or null.
  function matchWithin(text, parsed) {
    if (parsed.words.length < 2) return null;
    return findIn(text, parsed.words.join(' '), parsed.leading, parsed.trailing);
  }

  const api = { parseQuery, findIn, matchAcross, matchWithin, fold };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HyperaudioSearchMatch = api;
})();

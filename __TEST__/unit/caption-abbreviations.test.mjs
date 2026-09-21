// #662 — the per-language abbreviation lists are data, and data can be wrong
// in ways no generator test would notice: a word that is also a whole sentence
// ("No."), an entry that the generator could never match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../../js/caption-abbreviations.js', import.meta.url), 'utf8');
const window = {};
new Function('window', src)(window);
const lists = window.HyperaudioCaptionAbbreviations;

test('lists are keyed by two-letter language code, plus "und" for no language', () => {
  const codes = Object.keys(lists);
  assert.ok(codes.includes('en') && codes.includes('und') && codes.length >= 5);
  codes.forEach((code) => assert.match(code, /^([a-z]{2}|und)$/));
});

test('every entry is something the generator can match', () => {
  for (const [code, list] of Object.entries(lists)) {
    assert.ok(Array.isArray(list) && list.length > 0, code);
    assert.equal(new Set(list.map((w) => w.toLowerCase())).size, list.length, `${code}: duplicate entry`);
    list.forEach((word) => {
      // one token, ending in the full stop that makes it ambiguous
      assert.match(word, /^\S+\.$/u, `${code}: ${word}`);
    });
  }
});

test('nothing listed is also a sentence of its own, or a usual sentence end', () => {
  const never = ['no.', 'etc.', 'jr.', 'sr.', 'usw.', 'ok.', 'i.'];
  // "Sr." is a title in Spanish and Portuguese, which is exactly why lists are per language
  const allowed = { es: ['sr.'], pt: ['sr.'] };
  for (const [code, list] of Object.entries(lists)) {
    list.forEach((word) => {
      const w = word.toLowerCase();
      if ((allowed[code] || []).includes(w)) return;
      assert.ok(!never.includes(w), `${code}: ${word} often ends a sentence`);
    });
  }
});

test('the file is data only', () => {
  assert.ok(Object.isFrozen(lists));
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /function|=>/);
});

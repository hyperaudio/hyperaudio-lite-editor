// #425 — the alignment rework, informed by ts-aligner v0.2.2. These pin the
// four behaviours the issue names: normalized matching, distributed
// insert-run timing, bounded large-input alignment, and the language-agnostic
// speaker rules the rework brought with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wa = require('../../js/word-alignment.js');

const timingsFor = (words, start = 0, dur = 0.5) =>
  words.map((_, i) => ({ start: start + i * dur, end: start + (i + 1) * dur }));

test('punctuation and case differences are matches, not substitutions (#425)', () => {
  const src = ['Hello,', 'world.', '“Quoted”', '(aside)'];
  const tgt = ['hello', 'world', 'quoted', 'aside'];
  const alignment = wa.alignWords(src, tgt);
  assert.deepEqual(alignment.map((a) => a.type), ['match', 'match', 'match', 'match']);
});

test('interior apostrophes and hyphens keep word identity', () => {
  assert.equal(wa.normalizeWord("Don't"), "don't");
  assert.equal(wa.normalizeWord('co-op,'), 'co-op');
});

test('an exact match is never substituted through (substitution costs 2)', () => {
  // naive cost-1 DP may substitute across "b"; the anchored alignment must
  // keep "b" matched and pay insert+delete around it instead
  const alignment = wa.alignWords(['x', 'b'], ['b', 'y']);
  const matched = alignment.find((a) => a.type === 'match');
  assert.ok(matched, 'the exact match "b" must survive as a match');
});

test('insert-run timings distribute across the anchor gap, monotonic and flush (#425)', () => {
  // machine: A B with a 2s silence between them; corrected inserts two words
  const src = ['alpha', 'omega'];
  const timings = [{ start: 0, end: 1 }, { start: 3, end: 4 }];
  const tgt = ['alpha', 'new', 'words', 'omega'];
  const alignment = wa.alignWords(src, tgt);
  const out = wa.generateAlignedJSON(alignment, src, tgt, timings, tgt.join(' '));
  const w = out.words;
  assert.equal(w.length, 4);
  // strictly inside the gap, flush to both anchors, no overlaps, monotonic
  assert.equal(w[1].start, 1);
  assert.equal(w[3].start, 3);
  assert.ok(Math.abs(w[2].end - 3) < 1e-9, 'run ends flush with the next anchor');
  for (let i = 1; i < w.length; i++) {
    assert.ok(w[i].start >= w[i - 1].end - 1e-9, 'no overlap');
  }
  assert.ok(w[1].end > w[1].start && w[2].end > w[2].start, 'no zero durations in an open gap');
});

test('a longer word takes a larger share of the gap (syllable weighting)', () => {
  const src = ['a', 'z'];
  const timings = [{ start: 0, end: 1 }, { start: 4, end: 5 }];
  const tgt = ['a', 'hi', 'undeniable', 'z']; // 1 vowel group vs 5
  const out = wa.generateAlignedJSON(wa.alignWords(src, tgt), src, tgt, timings, tgt.join(' '));
  const short = out.words[1], long = out.words[2];
  assert.ok((long.end - long.start) > (short.end - short.start) * 2,
    'the multi-syllable word takes the visibly larger share');
});

test('inserted words before the first anchor back-fill toward it, clamped at zero', () => {
  const src = ['omega'];
  const timings = [{ start: 0.3, end: 1 }];
  const tgt = ['brand', 'new', 'omega'];
  const out = wa.generateAlignedJSON(wa.alignWords(src, tgt), src, tgt, timings, tgt.join(' '));
  const w = out.words;
  assert.ok(w[0].start >= 0);
  assert.ok(Math.abs(w[1].end - 0.3) < 1e-9, 'run ends where the first anchor begins');
  assert.ok(w[1].start >= w[0].end - 1e-9);
});

test('inserted words after the last anchor run on at nominal pace', () => {
  const src = ['alpha'];
  const timings = [{ start: 0, end: 1 }];
  const tgt = ['alpha', 'trailing', 'words'];
  const out = wa.generateAlignedJSON(wa.alignWords(src, tgt), src, tgt, timings, tgt.join(' '));
  const w = out.words;
  assert.equal(w[1].start, 1);
  assert.ok(w[2].end > w[2].start && w[1].end > w[1].start);
  assert.ok(w[2].start >= w[1].end - 1e-9);
});

test('banded alignment agrees with the full table on a drifted transcript (#425)', () => {
  // 400 words with scattered edits: substitutions, an insertion run, deletions
  const src = Array.from({ length: 400 }, (_, i) => 'word' + i);
  const tgt = src.slice();
  tgt[50] = 'changed';
  tgt.splice(200, 0, 'extra', 'inserted', 'words');
  tgt.splice(300, 4);
  const standard = wa.alignWordsStandard(src, tgt);
  const banded = wa.alignWordsBanded(src, tgt, 40);
  assert.deepEqual(banded, standard);
});

test('the greedy fallback terminates and stays sane on disjoint inputs', () => {
  const alignment = wa.alignWordsGreedy(['a', 'b', 'c'], ['x', 'y', 'z', 'w']);
  assert.equal(alignment.filter((a) => a.targetIdx !== null).length, 4);
  assert.equal(alignment.filter((a) => a.sourceIdx !== null).length, 3);
});

test('speaker detection is language-agnostic (#425)', () => {
  // the old rules required a capital [A-Z0-9] after the label — every
  // non-Latin transcript was rejected outright
  assert.equal(wa.isValidSpeakerPattern('[María] él dijo algo').isValid, true);
  assert.equal(wa.isValidSpeakerPattern('[田中] こんにちは').isValid, true);
  assert.equal(wa.isValidSpeakerPattern('Алиса: привет').isValid, true);
  assert.equal(wa.isValidSpeakerPattern('[Bob] Hello').speaker, 'Bob');
});

test('sentences with colons are not speakers', () => {
  assert.equal(wa.isValidSpeakerPattern('The meeting at 3:30 was long').isValid, false);
  assert.equal(wa.isValidSpeakerPattern('This sentence, with a comma, has a colon: here').isValid, false);
  const seven = wa.isValidSpeakerPattern('one two three four five six seven: text');
  assert.equal(seven.isValid, false);
});

// #395 — the transcript search's one rule: what you type must be there; what
// you don't type is ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const m = createRequire(import.meta.url)('../../js/search-match.js');

// the text of `word` that `query` matches, or null
const hit = (query, word) => {
  const ranges = m.matchAcross([word], m.parseQuery(query));
  return ranges === null ? null : word.slice(...ranges[0]);
};

test('with no spaces or punctuation typed, matching is unchanged: substrings, any case', () => {
  assert.equal(hit('um', 'album '), 'um');
  assert.equal(hit('um', 'Umbrella '), 'Um');
  assert.equal(hit('CAPTIONS', 'captions. '), 'captions');
});

test('a space typed before or after the query is a word edge', () => {
  assert.equal(hit(' um ', 'um '), 'um');
  assert.equal(hit(' um ', 'album '), null);
  assert.equal(hit(' um ', 'umbrella '), null);
  assert.equal(hit('um ', 'album '), 'um');
  assert.equal(hit('um ', 'umbrella '), null);
  assert.equal(hit(' um', 'umbrella '), 'um');
  assert.equal(hit(' um', 'album '), null);
});

test('punctuation around a whole word does not stop it being whole, and stays outside the match', () => {
  assert.equal(hit(' um ', 'um, '), 'um');
  assert.equal(hit(' um ', '(um) '), 'um');
  assert.equal(hit(' um ', '“Um.” '), 'Um');
});

test('punctuation typed must be there', () => {
  assert.equal(hit('U.S.', 'U.S. '), 'U.S.');
  assert.equal(hit('U.S.', 'us '), null);
  assert.equal(hit('U.S.', 'focus '), null);
  assert.equal(hit("it's", "it's "), "it's");
  assert.equal(hit("it's", 'its '), null);
  assert.equal(hit('?', 'really? '), '?');
  assert.equal(hit('?', 'really. '), null);
});

test('a straight quote matches a curly one', () => {
  assert.equal(hit("it's", 'it’s '), 'it’s');
  assert.equal(hit("we'll", 'We’ll '), 'We’ll');
});

test('punctuation not typed is skipped, inside a word too (#260)', () => {
  assert.equal(hit('its', "it's "), "it's");
  assert.equal(hit('speaker2', 'SPEAKER-2 '), 'SPEAKER-2');
  assert.equal(hit('speaker-2', 'SPEAKER-2 '), 'SPEAKER-2');
  assert.equal(hit('us', 'U.S. '), 'U.S');
});

test('in a phrase, the inner edges are always word edges', () => {
  const p = m.parseQuery('big pharma');
  assert.deepEqual(m.matchAcross(['big ', 'pharma '], p), [[0, 3], [0, 6]]);
  assert.equal(m.matchAcross(['bigger ', 'pharma '], p), null);     // "big" must end its word
  assert.equal(m.matchAcross(['big ', 'apharma '], p), null);       // "pharma" must start its word
  assert.deepEqual(m.matchAcross(['abig ', 'pharmacy '], p), [[1, 4], [0, 6]]);   // outer edges free
  assert.equal(m.matchAcross(['abig ', 'pharmacy '], m.parseQuery(' big pharma ')), null);
});

test('a token of punctuation alone joins the word before it, or after it at the start', () => {
  assert.deepEqual(m.parseQuery('big , pharma').words, ['big,', 'pharma']);
  assert.deepEqual(m.parseQuery('( big').words, ['(big']);
  assert.deepEqual(m.parseQuery('?').words, ['?']);
  assert.equal(m.parseQuery('   '), null);
  assert.deepEqual(m.parseQuery(' um ').words, ['um']);
  assert.equal(m.parseQuery(' um ').leading, true);
  assert.equal(m.parseQuery('um').trailing, false);
});

test('a phrase inside one span, such as a speaker label (#568)', () => {
  const label = '[Teon Brooks] ';
  const within = (q) => { const r = m.matchWithin(label, m.parseQuery(q)); return r === null ? null : label.slice(...r); };
  assert.equal(within('teon brooks'), 'Teon Brooks');
  assert.equal(within('[Teon Brooks]'), '[Teon Brooks]');
  assert.equal(within(' teon brooks '), 'Teon Brooks');
  assert.equal(within('eon brook'), 'eon Brook');
  assert.equal(within(' eon brook'), null);
  assert.equal(within('teonbrooks'), null);           // one word: the cross-span pass's job
  assert.equal(within('teon  brooks'), 'Teon Brooks'); // runs of spaces are one gap
});

test('a match range is a range of the original text, whatever case folding does', () => {
  assert.deepEqual(m.findIn('İstanbul ', 'stanbul', false, false), [1, 8]);
});

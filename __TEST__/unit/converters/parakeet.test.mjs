// #751 — Parakeet's word list as the editor's transcript, from a fixture of
// the Hugging Face endpoint's verbose_json; the editor's own worker returns
// the same `{ words: [{ word, start, end }] }` without the language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { parakeet } = require('../../../js/converters/parakeet.js');
const fixture = () => JSON.parse(readFileSync(new URL('../../fixtures/converters/parakeet.json', import.meta.url), 'utf8'));

test('the endpoint\'s words, no speakers, a paragraph after the long pause, and the language it names', () => {
  const r = parakeet(fixture());
  assert.equal(r.words.length, 19);
  assert.deepEqual(r.words[0], { text: 'We', start: 0.08, end: 0.24 });
  assert.deepEqual(r.words[18], { text: 'more.', start: 8.92, end: 9.4 });
  // "potential." then 4.44 s of nothing: a new paragraph at "There"
  assert.deepEqual(r.paragraphs, [{ start: 0.08, end: 3.76 }, { start: 8.2, end: 9.4 }]);
  assert.equal(r.language, 'en');
});

// Nemotron on the Hugging Face router (#777): the same word list, and the
// language field echoes the request rather than naming what was heard
test('nemotron\'s answer: its words, and "" or "auto" is no language', () => {
  const nemotron = JSON.parse(readFileSync(new URL('../../fixtures/converters/nemotron.json', import.meta.url), 'utf8'));
  const r = parakeet(nemotron);
  assert.equal(r.words.length, 162);
  assert.equal(r.words[0].text, 'The');
  assert.ok(r.words[0].start < r.words[0].end && r.words[161].end < 63);
  assert.equal(r.language, undefined);
  assert.equal(parakeet({ ...nemotron, language: 'auto' }).language, undefined);
  assert.equal(parakeet({ ...nemotron, language: 'fr' }).language, 'fr');
});

test('the worker\'s output: the same words, no language', () => {
  const r = parakeet({ words: fixture().words });
  assert.equal(r.words.length, 19);
  assert.equal(r.language, undefined);
  assert.deepEqual(parakeet({ words: [] }), { words: [], paragraphs: [], language: undefined });
});

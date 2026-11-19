// #815 — the More languages engine's frames as the editor's transcript. The
// fixture is Swecha Gonthuka's real output for two Telugu clips joined with
// 1.3 s of silence, which the model crossed with no word separator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { wav2vec2 } = require('../../../js/converters/wav2vec2.js');
const { jsonToHTML } = require('../../../js/html-json-converter.js');
const fixture = require('../../fixtures/converters/wav2vec2.json');

test('the frames become timed words, the first ones as the model wrote them', () => {
  const t = wav2vec2(fixture);
  assert.equal(t.words.length, 12);
  assert.deepEqual(t.words.slice(0, 3).map((w) => [w.text, w.start, w.end]), [['అది', 0.68, 0.82], ['నాకు', 0.88, 1.04], ['అర్ధం', 1.08, 1.36]]);
  assert.equal(t.language, 'te');
  assert.ok(t.words.every((w) => w.speaker === undefined));
  assert.ok(t.words.every((w, i) => i === 0 || w.start >= t.words[i - 1].end));
});

test('a pause ends a word even where the model wrote no separator', () => {
  const t = wav2vec2(fixture);
  const i = t.words.findIndex((w) => w.text === 'కాదు');
  assert.equal(t.words[i + 1].text, 'ఆర్టోడాక్స్');
  // the model gave blanks only between them, so the pause alone split them
  const between = fixture.frames.slice(Math.round(t.words[i].end / 0.02), Math.round(t.words[i + 1].start / 0.02));
  assert.ok(between.length > 0 && between.every((id) => id === fixture.blank));
});

test('repeats collapse, blanks and special tokens are never text, and the separator splits', () => {
  const vocab = ['<s>', '<pad>', '</s>', '<unk>', '|', 'a', 'b'];
  const json = { frames: [1, 5, 5, 1, 5, 4, 3, 6, 6, 4, 0, 1], vocab, frameSeconds: 0.02, blank: 1, separator: 4 };
  const t = wav2vec2(json);
  assert.deepEqual(t.words.map((w) => [w.text, w.start, w.end]), [['aa', 0.02, 0.1], ['b', 0.14, 0.18]]);
  assert.equal(t.language, undefined);
});

test('nothing in, nothing out', () => {
  assert.deepEqual(wav2vec2({ frames: [], vocab: [] }).words, []);
  assert.deepEqual(wav2vec2({}).words, []);
});

test('one render: words and a paragraph, no speaker labels', () => {
  const t = wav2vec2(fixture);
  const html = jsonToHTML({ words: t.words, paragraphs: t.paragraphs });
  assert.equal((html.match(/<p/g) || []).length, 1);
  assert.equal((html.match(/class="speaker"/g) || []).length, 0);
  assert.equal((html.match(/data-m=/g) || []).length, 12);
});

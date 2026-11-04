// #751 — AssemblyAI's transcript as the editor's, from a fixture of the real
// format: milliseconds to seconds, speaker letters to labels, and no labels
// at all when the request did not ask for speakers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { assemblyai } = require('../../../js/converters/assemblyai.js');
const fixture = () => JSON.parse(readFileSync(new URL('../../fixtures/converters/assemblyai.json', import.meta.url), 'utf8'));

test('words in seconds with their speaker as a label, paragraphs on the change of speaker, the language as given', () => {
  const r = assemblyai(fixture());
  assert.equal(r.words.length, 19);
  assert.deepEqual(r.words[0], { text: 'We', start: 0.08, end: 0.24, speaker: 'speaker-A' });
  assert.deepEqual(r.words[7], { text: 'Well', start: 1.84, end: 2.08, speaker: 'speaker-B' });
  assert.deepEqual(r.paragraphs, [
    { start: 0.08, end: 1.76, speaker: 'speaker-A' },
    { start: 1.84, end: 6.4, speaker: 'speaker-B' },
  ]);
  assert.equal(r.language, 'en_us');
});

test('one speaker across a long pause: a second paragraph, no second label', () => {
  const json = fixture();
  json.words.forEach((w) => { w.speaker = 'A'; });
  json.words.slice(7).forEach((w) => { w.start += 5000; w.end += 5000; });
  assert.deepEqual(assemblyai(json).paragraphs, [{ start: 0.08, end: 1.76, speaker: 'speaker-A' }, { start: 6.84, end: 11.4 }]);
});

test('without speaker labels there are no speakers, and one paragraph until the rule says otherwise', () => {
  const json = fixture();
  json.words.forEach((w) => { w.speaker = null; });
  delete json.language_code;
  const r = assemblyai(json);
  assert.ok(r.words.every((w) => w.speaker === undefined));
  assert.deepEqual(r.paragraphs, [{ start: 0.08, end: 6.4 }]);
  assert.equal(r.language, undefined);
  // a sentence end followed by more than 4 s of nothing starts a paragraph
  json.words.slice(14).forEach((w) => { w.start += 4000; w.end += 4000; });
  assert.deepEqual(assemblyai(json).paragraphs.map((p) => p.start), [0.08, 9.2]);
});

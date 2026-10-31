// #751 — the Whisper JSON converter under its own door. The five dialects
// and their awkward parts are pinned in whisper-json-import.test.mjs, which
// reaches the same code through the import module; this checks the two are
// one, and the result's form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { whisperJson, detectDialect } = require('../../../js/converters/whisper-json.js');
const importer = require('../../../js/whisper-json-import.js');
const chunks = () => JSON.parse(readFileSync(new URL('../../fixtures/converters/whisper-chunks.json', import.meta.url), 'utf8'));

test('the transformers dialect from a fixture: the dialect named, the words trimmed, noise dropped, paragraphs placed', () => {
  const r = whisperJson(chunks());
  assert.equal(r.dialect, 'transformers');
  assert.equal(detectDialect(chunks()), 'transformers');
  assert.equal(r.words.length, 19);
  assert.deepEqual(r.words[0], { text: 'We', start: 0.08, end: 0.24 });
  assert.deepEqual(r.paragraphs.map((p) => p.start), [0.08, 5.84]);
  assert.equal(r.language, null);
});

test('the import module\'s door is the converter', () => {
  assert.deepEqual(importer.whisperJsonToTranscript(chunks()), whisperJson(chunks()));
  assert.equal(importer.detectDialect({ segments: [] }), 'whisper');
  assert.throws(() => whisperJson({ hello: 1 }), /does not look like Whisper JSON/);
});

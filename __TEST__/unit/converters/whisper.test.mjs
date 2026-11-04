// #751 — the editor's own Whisper output as the editor's transcript, from a
// fixture of what the transformers.js pipeline returns: the leading space
// trimmed, noise tokens and empty chunks dropped before paragraphs are
// placed, and a last chunk with no end given half a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { whisper } = require('../../../js/converters/whisper.js');
const fixture = () => JSON.parse(readFileSync(new URL('../../fixtures/converters/whisper-chunks.json', import.meta.url), 'utf8'));

test('the chunks as words: trimmed, noise and empties dropped, the open-ended last one closed', () => {
  const r = whisper(fixture());
  assert.deepEqual(r.words.map((w) => w.text), ['We', 'could', 'be', 'there', 'at', 'the', 'start.', 'Well', 'if', 'you', 'tap', 'into', 'that', 'potential.', 'There', 'has', 'to', 'be', 'more.']);
  assert.deepEqual(r.words[0], { text: 'We', start: 0.08, end: 0.24 });
  assert.deepEqual(r.words[18], { text: 'more.', start: 8.92, end: 9.42 });
  assert.ok(r.words.every((w) => w.speaker === undefined));
});

test('a dropped noise token cannot hide the pause it sat in: the paragraph breaks after "start."', () => {
  const r = whisper(fixture());
  // [BLANK_AUDIO] spanned 1.76 to 5.1 and "Well" starts at 5.84: a 4.08 s
  // gap between the words either side of it, so a new paragraph
  assert.deepEqual(r.paragraphs.map((p) => p.start), [0.08, 5.84]);
  assert.deepEqual(whisper({ chunks: [] }), { words: [], paragraphs: [] });
});

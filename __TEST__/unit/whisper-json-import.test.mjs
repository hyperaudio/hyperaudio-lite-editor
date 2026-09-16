// #631 — Whisper JSON arrives in five dialects and the editor has to read
// them all into one canonical transcript. The formats are fixed, so these
// pin each one, plus the awkward parts they share: the space that belongs to
// the front of a word, non-speech tokens, and words with no timing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { whisperJsonToTranscript, detectDialect } = require('../../js/whisper-json-import.js');

const texts = (r) => r.words.map((w) => w.text);

test('the dialects are told apart, and rubbish is refused (#631)', () => {
  assert.equal(detectDialect({ segments: [] }), 'whisper');
  assert.equal(detectDialect({ segments: [{ speaker: 'SPEAKER_00' }] }), 'whisperx');
  assert.equal(detectDialect({ words: [] }), 'openai-words');
  assert.equal(detectDialect({ transcription: [] }), 'whisper.cpp');
  assert.equal(detectDialect({ chunks: [] }), 'transformers');
  assert.equal(detectDialect({ hello: 1 }), null);
  assert.throws(() => whisperJsonToTranscript({ hello: 1 }), /does not look like Whisper JSON/);
  assert.throws(() => whisperJsonToTranscript({ segments: [] }), /no words/);
});

test('Whisper CLI with word timestamps keeps every word timing (#631)', () => {
  const r = whisperJsonToTranscript({
    language: 'en',
    segments: [{
      start: 1.0, end: 2.4, text: ' Hello there world.',
      words: [
        { word: ' Hello', start: 1.0, end: 1.4, probability: 0.9 },
        { word: ' there', start: 1.5, end: 1.9 },
        { word: ' world.', start: 2.0, end: 2.4 },
      ],
    }],
  });
  assert.equal(r.dialect, 'whisper');
  assert.equal(r.language, 'en');
  assert.deepEqual(texts(r), ['Hello', 'there', 'world.']);
  assert.deepEqual(r.words[0], { start: 1.0, end: 1.4, text: 'Hello' });
  assert.equal(r.paragraphs.length, 1);
  assert.equal(r.paragraphs[0].start, 1.0);
  assert.equal(r.paragraphs[0].end, 2.4);
});

test('a segment-only file spreads its words across the segment, in order (#631)', () => {
  const r = whisperJsonToTranscript({
    segments: [{ start: 10, end: 14, text: 'incomprehensibility is a long word' }],
  });
  assert.deepEqual(texts(r), ['incomprehensibility', 'is', 'a', 'long', 'word']);
  assert.equal(r.words[0].start, 10);
  assert.equal(r.words[r.words.length - 1].end, 14);
  // monotonic, and the long word earns the longest share
  r.words.forEach((w, i) => {
    assert.ok(w.end >= w.start, `word ${i} runs backwards`);
    if (i > 0) assert.ok(w.start >= r.words[i - 1].end - 1e-9, `word ${i} starts before the last ended`);
  });
  const longest = r.words.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  assert.equal(longest.text, 'incomprehensibility');
});

test('OpenAI verbose_json word granularity (top-level words) (#631)', () => {
  const r = whisperJsonToTranscript({
    task: 'transcribe', language: 'english', duration: 2.4,
    text: 'Hello there',
    words: [{ word: 'Hello', start: 0.1, end: 0.4 }, { word: 'there', start: 0.5, end: 0.8 }],
  });
  assert.equal(r.dialect, 'openai-words');
  assert.deepEqual(texts(r), ['Hello', 'there']);
  assert.equal(r.words[1].end, 0.8);
});

test('whisper.cpp offsets are milliseconds (#631)', () => {
  const r = whisperJsonToTranscript({
    transcription: [
      { timestamps: { from: '00:00:00,000', to: '00:00:02,000' }, offsets: { from: 0, to: 2000 }, text: ' Hello there' },
      { timestamps: { from: '00:00:02,000', to: '00:00:03,000' }, offsets: { from: 2000, to: 3000 }, text: ' again' },
    ],
  });
  assert.equal(r.dialect, 'whisper.cpp');
  assert.deepEqual(texts(r), ['Hello', 'there', 'again']);
  assert.equal(r.words[0].start, 0);
  assert.equal(r.words[r.words.length - 1].end, 3);   // seconds, not 3000
});

test('WhisperX speakers become paragraphs, one per change (#631)', () => {
  const r = whisperJsonToTranscript({
    segments: [
      { start: 0, end: 1, speaker: 'SPEAKER_00', text: 'hello there',
        words: [{ word: 'hello', start: 0, end: 0.5, speaker: 'SPEAKER_00' }, { word: 'there', start: 0.5, end: 1, speaker: 'SPEAKER_00' }] },
      { start: 1.2, end: 2, speaker: 'SPEAKER_01', text: 'hi back',
        words: [{ word: 'hi', start: 1.2, end: 1.5, speaker: 'SPEAKER_01' }, { word: 'back', start: 1.6, end: 2, speaker: 'SPEAKER_01' }] },
      { start: 2.2, end: 3, speaker: 'SPEAKER_00', text: 'goodbye',
        words: [{ word: 'goodbye', start: 2.2, end: 3, speaker: 'SPEAKER_00' }] },
    ],
  });
  assert.equal(r.dialect, 'whisperx');
  assert.deepEqual(r.paragraphs.map((p) => p.speaker), ['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00']);
  assert.deepEqual(r.paragraphs.map((p) => [p.start, p.end]), [[0, 1], [1.2, 2], [2.2, 3]]);
});

test("transformers.js chunks — the editor's own local Whisper output (#631)", () => {
  const r = whisperJsonToTranscript({
    text: ' Hello there',
    chunks: [
      { text: ' Hello', timestamp: [0.32, 0.4] },
      { text: ' there', timestamp: [0.56, null] },   // the last chunk often has no end
    ],
  });
  assert.equal(r.dialect, 'transformers');
  assert.deepEqual(texts(r), ['Hello', 'there']);
  assert.equal(r.words[0].start, 0.32);
  assert.ok(r.words[1].end > r.words[1].start, 'the open-ended last word got an end');
});

test('non-speech markers are dropped, wherever they sit (#631)', () => {
  const r = whisperJsonToTranscript({
    chunks: [
      { text: ' [BLANK_AUDIO]', timestamp: [0, 1] },
      { text: ' Hello', timestamp: [1, 1.5] },
      { text: ' (applause)', timestamp: [1.5, 2] },
      { text: ' ♪', timestamp: [2, 2.5] },
      { text: ' world', timestamp: [2.5, 3] },
    ],
  });
  assert.deepEqual(texts(r), ['Hello', 'world']);
});

test('words the aligner could not place are interpolated, not dropped (#631)', () => {
  const r = whisperJsonToTranscript({
    segments: [{
      start: 0, end: 3, text: 'one two three four',
      words: [
        { word: 'one', start: 0, end: 0.5 },
        { word: 'two' },                       // WhisperX leaves these off
        { word: 'three' },
        { word: 'four', start: 2.5, end: 3 },
      ],
    }],
  });
  assert.deepEqual(texts(r), ['one', 'two', 'three', 'four']);
  r.words.forEach((w) => {
    assert.ok(Number.isFinite(w.start) && Number.isFinite(w.end), `${w.text} has no timing`);
  });
  assert.ok(r.words[1].start >= 0.5 && r.words[2].end <= 2.5, 'the run sits between its neighbours');
  assert.ok(r.words[1].end <= r.words[2].start + 1e-9);
});

test('a word with no leading space is glued to the one before it (#631)', () => {
  // how "speech-to-text" survives as one word rather than three
  const r = whisperJsonToTranscript({
    chunks: [
      { text: ' speech', timestamp: [0, 0.3] },
      { text: '-to', timestamp: [0.3, 0.4] },
      { text: '-text', timestamp: [0.4, 0.6] },
      { text: ' now', timestamp: [0.7, 1.0] },
    ],
  });
  assert.deepEqual(texts(r), ['speech', '-to', '-text', 'now']);
  assert.equal(r.words[0].space, false);
  assert.equal(r.words[1].space, false);
  assert.equal(r.words[2].space, undefined);   // a normal word carries no flag
});

test('a long gap after a finished sentence starts a new paragraph (#631)', () => {
  const r = whisperJsonToTranscript({
    chunks: [
      { text: ' One.', timestamp: [0, 1] },
      { text: ' Two', timestamp: [9, 10] },      // 8s later
      { text: ' three', timestamp: [10, 11] },
    ],
  });
  assert.equal(r.paragraphs.length, 2);
  assert.equal(r.paragraphs[0].end, 1);
  assert.equal(r.paragraphs[1].start, 9);
});

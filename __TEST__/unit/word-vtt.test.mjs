// Unit tests for the word-level ("karaoke") VTT export (#387 part 1).
// Exercises the pure logic — timestamp formatting, chunk boundaries, duration
// backfill, speaker skipping, and the assembled VTT — without a browser DOM
// (generateWordVtt accepts a transcript root via options.source).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateWordVtt, formatTimestamp, readWords, chunkWords } = require('../../js/word-vtt.js');

// Build a mock transcript root: spans carry data-m/data-d in ms; a `speaker`
// flag marks a label span (which must be excluded from the word list).
function mockRoot(spans) {
  return {
    querySelectorAll: () => spans.map((s) => ({
      getAttribute: (n) => (n === 'data-m' ? String(s.m) : String(s.d)),
      classList: { contains: (c) => c === 'speaker' && !!s.speaker },
      textContent: s.t,
    })),
  };
}

test('formatTimestamp: HH:MM:SS.mmm, clamps negatives to zero', () => {
  assert.equal(formatTimestamp(2.65), '00:00:02.650');
  assert.equal(formatTimestamp(3661.5), '01:01:01.500');
  assert.equal(formatTimestamp(-1), '00:00:00.000');
});

test('chunkWords: splits on maxWords and on a pause > maxGap', () => {
  const words = [
    { start: 0, end: 0.3 }, { start: 0.35, end: 0.6 }, // close pair
    { start: 2, end: 2.3 },                            // 1.4s gap -> new chunk
  ];
  const chunks = chunkWords(words, 5, 0.8);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 2);

  const six = Array.from({ length: 6 }, (_, i) => ({ start: i * 0.1, end: i * 0.1 + 0.05 }));
  const byCount = chunkWords(six, 5, 0.8);       // no gaps -> split purely by count
  assert.deepEqual(byCount.map((c) => c.length), [5, 1]);
});

test('readWords: skips speaker labels and backfills zero durations', () => {
  const root = mockRoot([
    { m: 0, d: 0, t: 'SPEAKER 1', speaker: true }, // excluded
    { m: 1000, d: 0, t: 'hello' },                 // zero dur -> filled from next start
    { m: 1600, d: 400, t: 'world' },
  ]);
  const words = readWords(root);
  assert.equal(words.length, 2);
  assert.equal(words[0].text, 'hello');
  assert.equal(words[0].end, 1.6);   // backfilled to next word's start
  assert.equal(words[1].end, 2.0);   // 1.6 + 0.4
});

test('readWords: trailing zero-duration word gets a 0.4s fallback span', () => {
  const words = readWords(mockRoot([{ m: 5000, d: 0, t: 'end' }]));
  assert.equal(words[0].start, 5.0);
  assert.equal(words[0].end, 5.4);
});

test('generateWordVtt: header, cue timing, inline per-word timestamps', () => {
  const root = mockRoot([
    { m: 1200, d: 300, t: 'So' }, { m: 1550, d: 300, t: 'if' },
    { m: 9000, d: 400, t: 'Yeah.' },   // >0.8s gap -> second cue
  ]);
  const vtt = generateWordVtt({ source: root, maxWords: 5, maxGap: 0.8 });
  assert.match(vtt, /^WEBVTT\n/);
  assert.match(vtt, /\n00:00:01\.200 --> 00:00:01\.850\n<00:00:01\.200>So <00:00:01\.550>if\n/);
  assert.match(vtt, /\n00:00:09\.000 --> 00:00:09\.400\n<00:00:09\.000>Yeah\.\n/);
});

test('generateWordVtt: no words yields just the header', () => {
  assert.equal(generateWordVtt({ source: mockRoot([]) }), 'WEBVTT\n');
});

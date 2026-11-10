// A word with no duration is given one, so that it stays in its own
// paragraph. Qwen3-ASR times a seventh of its words as an instant: a
// sentence-final word at the start of the word after it, and jsonToHTML's tie
// rule then opened the next paragraph with it: "interested in / doing. And I
// was". A sentence-initial word gets the instant it began at, after a pause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shared = require('../../../js/converters/transcript-words.js');
const { paragraphStarts } = require('../../../js/paragraph-rule.js');
const { jsonToHTML } = require('../../../js/html-json-converter.js');

const w = (start, end, text) => ({ start, end, text });
const near = (a, b) => Math.abs(a - b) < 1e-9;
const times = (word) => [+word.start.toFixed(3), +word.end.toFixed(3)];

test('a sentence-final word timed at the next word\'s start reaches back, up to 0.3 s and never past the word before', () => {
  const words = shared.withDurations([w(170.94, 171.42, 'interested'), w(171.42, 171.58, 'in'), w(172.3, 172.3, 'doing.'), w(172.3, 172.54, 'And')]);
  assert.deepEqual(times(words[2]), [172.0, 172.3]);
  assert.deepEqual(words[1], w(171.42, 171.58, 'in'));   // the others untouched
  assert.deepEqual(words[3], w(172.3, 172.54, 'And'));
  const close = shared.withDurations([w(83.2, 83.44, 'in'), w(83.76, 83.76, 'Akron.'), w(85.68, 85.68, 'Wow!'), w(88.0, 88.3, 'And')]);
  assert.deepEqual(times(close[1]), [83.46, 83.76]);
  // a one-word sentence after a sentence end BEGAN at its instant: forward, and the pause before it stays
  assert.deepEqual(times(close[2]), [85.68, 85.93]);
});

test('any other word reaches forward, up to 0.25 s and never past the word after', () => {
  const forward = shared.withDurations([w(1.0, 1.4, 'Birth'), w(1.4, 1.4, 'and'), w(1.9, 2.2, 'Beautiful')]);
  assert.deepEqual(times(forward[1]), [1.4, 1.65]);
  const squeezed = shared.withDurations([w(1.0, 1.4, 'Birth'), w(1.4, 1.4, 'and'), w(1.42, 1.9, 'Beautiful')]);
  assert.deepEqual(times(squeezed[1]), [1.4, 1.42]);
  const stuck = shared.withDurations([w(1.0, 1.4, 'Birth'), w(1.4, 1.4, 'and'), w(1.4, 1.9, 'Beautiful')]);
  assert.ok(stuck[1].start < 1.4 && stuck[1].end === 1.4 && stuck[1].start >= 1.0, JSON.stringify(stuck[1]));
  const first = shared.withDurations([w(0.5, 0.5, 'Record'), w(0.9, 1.2, 'on')]);
  assert.deepEqual(times(first[0]), [0.5, 0.75]);
  const alone = shared.withDurations([w(0.5, 0.5, 'Record')]);
  assert.deepEqual(times(alone[0]), [0.5, 0.75]);
  const firstFinal = shared.withDurations([w(0.5, 0.5, 'Okay.'), w(0.9, 1.2, 'So')]);
  assert.deepEqual(times(firstFinal[0]), [0.2, 0.5]);
});

test('a run of words sharing one instant shares the reach equally', () => {
  const back = shared.withDurations([w(1.0, 1.4, 'a'), w(2.3, 2.3, 'b'), w(2.3, 2.3, 'c.'), w(2.3, 2.6, 'D')]);
  assert.deepEqual(times(back[1]), [1.7, 2.0]);
  assert.deepEqual(times(back[2]), [2.0, 2.3]);
  const forward = shared.withDurations([w(1.0, 1.4, 'a.'), w(2.3, 2.3, 'B'), w(2.3, 2.3, 'c'), w(2.6, 2.9, 'd')]);
  assert.deepEqual(times(forward[1]), [2.3, 2.45]);
  assert.deepEqual(times(forward[2]), [2.45, 2.6]);
  assert.ok(forward.every((x, i) => i === 0 || x.start >= forward[i - 1].start));
});

test('the sentence-final word stays in its paragraph when the rule breaks after it', () => {
  // past the 100-word line, the last word of the sentence timed as an instant at the next word's start
  const words = [];
  let at = 0;
  for (let i = 0; i < 110; i += 1) { words.push(w(at, at + 0.3, 'word')); at += 0.3; }
  words.push(w(at + 0.4, at + 0.4, 'end.'));
  words.push(w(at + 0.4, at + 0.7, 'Next'));
  words.push(w(at + 0.7, at + 1.0, 'one.'));
  const transcript = shared.transcriptFromWords(words);
  assert.equal(transcript.paragraphs.length, 2);
  const html = jsonToHTML({ words: transcript.words, paragraphs: transcript.paragraphs });
  const paragraphs = html.split('<p>').slice(1).map((p) => p.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  assert.match(paragraphs[0], /word end\.$/);
  assert.equal(paragraphs[1], 'Next one.');
});

test('the pause before a one-word sentence still breaks the paragraph', () => {
  const words = [];
  let at = 0;
  for (let i = 0; i < 24; i += 1) { words.push(w(at, at + 0.3, i === 23 ? 'Akron.' : 'word')); at += 0.3; }
  words.push(w(at + 1.9, at + 1.9, 'Wow!'));
  words.push(w(at + 4.0, at + 4.3, 'And'));
  assert.deepEqual([...paragraphStarts(shared.withDurations(words))], [24]);
});

test('words with durations pass through unchanged', () => {
  const words = [w(0, 0.3, 'a'), w(0.3, 0.6, 'b'), { start: 0.6, end: 0.9, text: 'c', speaker: 'A', space: false }];
  assert.deepEqual(shared.withDurations(words), words);
});

// Nemotron on a long recording has stamped a passage into a few seconds
// (an 18-minute debate, three such stretches): the stretch is named, and
// left as it came. Twelve words inside a second and a half is the mark,
// a dozen words shared by two people talking at once is not the engine's
// doing and stays unnamed, and the list's order does not matter.
test('squeezedRanges: a passage timed faster than ordinary speech is named, a plausible one is not', () => {
  const steady = (n, from, step) => Array.from({ length: n }, (_, i) => w(from + i * step, from + i * step + step * 0.8, 'w' + i));
  assert.deepEqual(shared.squeezedRanges(steady(80, 0, 0.2)), []);          // five words a second: fast, and spoken
  const words = steady(60, 0, 0.3).concat(steady(30, 20, 0.05), steady(50, 25, 0.3));
  const ranges = shared.squeezedRanges(words);
  assert.deepEqual(ranges, [{ start: 20, end: 21.49, words: 30 }]);
  assert.deepEqual(shared.squeezedRanges(words.slice().reverse()), ranges);
  // a dozen words in a second: two people at once, left alone
  assert.deepEqual(shared.squeezedRanges(steady(60, 0, 0.3).concat(steady(12, 20, 0.1), steady(50, 25, 0.3))), []);
  // two squeezed runs within three seconds are one stretch
  const two = steady(30, 0, 0.3).concat(steady(14, 10, 0.05), steady(14, 12.5, 0.05), steady(30, 20, 0.3));
  assert.deepEqual(shared.squeezedRanges(two), [{ start: 10, end: 13.19, words: 28 }]);
  assert.deepEqual(shared.squeezedRanges([]), []);
  assert.deepEqual(shared.squeezedRanges([{ text: 'untimed' }]), []);
  assert.deepEqual(shared.squeezedRanges(undefined), []);
});

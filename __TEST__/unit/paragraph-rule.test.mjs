// #743 — one paragraph rule for every engine and import. It must be exactly
// the rule the Parakeet engines applied inline, plus a break on every change
// of speaker (which Deepgram and AssemblyAI added beside it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { paragraphStarts } = require('../../js/paragraph-rule.js');

// the Parakeet loop, as it stood in hyperaudio-lite-editor-parakeet-local.js,
// with Deepgram's speaker break after it
function oldRule(words) {
  const starts = new Set();
  let previousElementEnd = 0;
  let wordsInPara = 0;
  words.forEach((element, index) => {
    wordsInPara++;
    if (previousElementEnd !== 0 && (element.start - previousElementEnd) > 4.0 || wordsInPara > 100) {
      const previousWord = words[index - 1].text;
      const c = previousWord.charAt(previousWord.length - 1);
      if (c === '.' || c === '?' || c === '!') { starts.add(index); wordsInPara = 0; }
    }
    if (index > 0 && (element.speaker || null) !== (words[index - 1].speaker || null)) { starts.add(index); wordsInPara = 0; }
    previousElementEnd = element.end;
  });
  return starts;
}

const random = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

test('the shared rule chooses exactly what the Parakeet loop chose, over random transcripts', () => {
  const rnd = random(743);
  const texts = ['so', 'and', 'the', 'end.', 'really?', 'yes!', 'e.g', 'well,', 'it'];
  for (let t = 0; t < 3000; t += 1) {
    const n = Math.floor(rnd() * 400);
    const speakers = rnd() < 0.3;
    let at = rnd() * 2;
    const words = [];
    for (let i = 0; i < n; i += 1) {
      const gap = rnd() < 0.1 ? 3.5 + rnd() : rnd() * 0.3;   // around the 4 s line
      const start = at + gap;
      const end = start + rnd() * 0.5;
      at = end;
      const w = { start, end, text: texts[Math.floor(rnd() * texts.length)] };
      if (speakers && rnd() < 0.97) w.speaker = rnd() < 0.05 ? 'B' : 'A';
      words.push(w);
    }
    assert.deepEqual([...paragraphStarts(words)], [...oldRule(words)], `case ${t}`);
  }
});

const w = (start, text, speaker) => ({ start, end: start + 0.3, text, speaker });

test('a change of speaker starts a paragraph, even mid-sentence', () => {
  const words = [w(0, 'I', 'A'), w(0.4, 'was', 'A'), w(0.8, 'saying', 'B'), w(1.2, 'that.', 'B')];
  assert.deepEqual([...paragraphStarts(words)], [2]);
});

test('a long pause starts a paragraph only after a sentence end', () => {
  const notAtSentenceEnd = [w(0, 'and'), w(10, 'then')];
  assert.deepEqual([...paragraphStarts(notAtSentenceEnd)], []);
  const atSentenceEnd = [w(0, 'done.'), w(10, 'Next')];
  assert.deepEqual([...paragraphStarts(atSentenceEnd)], [1]);
});

test('a paragraph past 100 words ends at the next sentence end', () => {
  const words = [];
  for (let i = 0; i < 130; i += 1) words.push(w(i * 0.4, i === 109 ? 'stop.' : 'word'));
  assert.deepEqual([...paragraphStarts(words)], [110]);
});

test('no speakers never reads as a change of speaker, and nothing breaks at the first word', () => {
  const words = [w(0, 'one.'), w(0.4, 'two.', null), w(0.8, 'three.', ''), w(1.2, 'four.')];
  assert.deepEqual([...paragraphStarts(words)], []);
  assert.deepEqual([...paragraphStarts([])], []);
});

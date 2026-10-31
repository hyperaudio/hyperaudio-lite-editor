// #751 — Deepgram's response as the editor's transcript, from a fixture of
// the real format: the first channel's first alternative, the text from
// punctuated_word, speakers as labels, and the summary, topics, language and
// model build read off the response. No page involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { deepgram } = require('../../../js/converters/deepgram.js');
const { jsonToHTML } = require('../../../js/html-json-converter.js');
const fixture = () => JSON.parse(readFileSync(new URL('../../fixtures/converters/deepgram.json', import.meta.url), 'utf8'));

test('the words, with their text from punctuated_word, their times in seconds and their speaker as a label', () => {
  const r = deepgram(fixture());
  assert.equal(r.words.length, 19);
  assert.deepEqual(r.words[0], { text: 'We', start: 0.08, end: 0.24, speaker: 'speaker-0' });
  assert.deepEqual(r.words[6], { text: 'start.', start: 1.28, end: 1.76, speaker: 'speaker-0' });
  assert.deepEqual(r.words[7], { text: 'Well', start: 1.84, end: 2.08, speaker: 'speaker-1' });
  // a word with no punctuated_word falls back to the plain word
  const json = fixture();
  delete json.results.channels[0].alternatives[0].words[0].punctuated_word;
  assert.equal(deepgram(json).words[0].text, 'we');
});

test('paragraphs break on the change of speaker and on the long pause after a sentence end', () => {
  const r = deepgram(fixture());
  // speaker-0's sentence, then speaker-1's two: the second after a 1.44 s
  // pause, under the rule's 4 s, so the two stay together
  assert.deepEqual(r.paragraphs, [
    { start: 0.08, end: 1.76, speaker: 'speaker-0' },
    { start: 1.84, end: 6.4, speaker: 'speaker-1' },
  ]);
  const json = fixture();
  json.results.channels[0].alternatives[0].words.slice(14).forEach((w) => { w.start += 4; w.end += 4; });
  assert.equal(deepgram(json).paragraphs.length, 3);
});

test('one speaker across a long pause: two paragraphs, one label, as the engine always wrote it', () => {
  const json = fixture();
  const words = json.results.channels[0].alternatives[0].words;
  words.forEach((w) => { w.speaker = 0; });
  words.slice(7).forEach((w) => { w.start += 5; w.end += 5; });
  const r = deepgram(json);
  assert.deepEqual(r.paragraphs, [{ start: 0.08, end: 1.76, speaker: 'speaker-0' }, { start: 6.84, end: 11.4 }]);
  assert.equal((jsonToHTML({ words: r.words, paragraphs: r.paragraphs }).match(/class="speaker"/g) || []).length, 1);
  assert.ok(r.words.every((w) => w.speaker === 'speaker-0'));   // the words keep theirs
});

test('the summary, the topics in order without repeats, the detected language and the model build', () => {
  const r = deepgram(fixture());
  assert.equal(r.summary, 'A talk about potential.');
  assert.deepEqual(r.topics, ['Industry', 'Potential']);
  assert.equal(r.language, 'en');
  assert.equal(r.engineVersion, '2024-01-06.5664');
  // none of them: empty, not an error
  const bare = { results: { channels: [{ alternatives: [{ words: [] }] }] } };
  assert.deepEqual(deepgram(bare), { words: [], paragraphs: [], summary: '', topics: [], language: undefined, engineVersion: undefined });
});

test('a lone word credited to the next speaker, hard on the previous one\'s word and far from its own, goes back', () => {
  const json = fixture();
  const words = json.results.channels[0].alternatives[0].words;
  // "start." tagged as speaker 1: it starts where "the" ended, and speaker
  // 1's next word is well after it (a 4 s gap opened for this)
  words[6].speaker = 1;
  words.slice(7).forEach((w) => { w.start += 4; w.end += 4; });
  const r = deepgram(json);
  assert.equal(r.words[6].speaker, 'speaker-0');
  assert.equal(r.words[7].speaker, 'speaker-1');
  // the response itself is left as it came
  assert.equal(words[6].speaker, 1);
});

test('rendered by jsonToHTML: labelled paragraphs, whole-millisecond times, the text as it was', () => {
  const r = deepgram(fixture());
  const html = jsonToHTML({ words: r.words, paragraphs: r.paragraphs });
  const spans = [...html.matchAll(/<span data-m="(\d+)" data-d="(\d+)"( class="speaker")?>([^<]*)<\/span>/g)]
    .map((m) => ({ ms: Number(m[1]), d: Number(m[2]), speaker: m[3] !== undefined, text: m[4].trim() }));
  assert.deepEqual(spans.filter((s) => s.speaker).map((s) => [s.text, s.ms]), [['[speaker-0]', 80], ['[speaker-1]', 1840]]);
  assert.deepEqual(spans.slice(0, 3).map((s) => [s.text, s.ms, s.d]), [['[speaker-0]', 80, 0], ['We', 80, 160], ['could', 240, 240]]);
  assert.equal((html.match(/<p>/g) || []).length, 2);
});

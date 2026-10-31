// #751 — a caption file as transcript markup, from an SRT and a WebVTT
// fixture: each cue's duration spread over its words in equal steps, the
// file's styling tags kept, a paragraph after the long pause, and the SRT
// and VTT forms of the same captions coming out the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { srt, vtt, captionWordsToHtml } = require('../../../js/converters/captions.js');
const read = (name) => readFileSync(new URL('../../fixtures/converters/' + name, import.meta.url), 'utf8');
const spans = (html) => [...html.matchAll(/<span data-m="(\d+)">(.*?) <\/span>/g)].map((m) => ({ ms: Number(m[1]), html: m[2] }));
const paragraphs = (html) => html.split('</p><p>').map((p) => spans(p).map((s) => s.html.replace(/<[^>]*>/g, '')).join(' '));

test('an SRT file: the words timed across their cues, the tags kept, and a paragraph after the pause', () => {
  const html = srt(read('sample.srt'));
  const words = spans(html);
  assert.equal(words.length, 19);
  // the first cue, 0.08 to 1.76 s over seven words: a step of 0.24 s
  assert.deepEqual(words.slice(0, 3).map((w) => [w.html, w.ms]), [['We', 80], ['could', 320], ['be', 560]]);
  assert.equal(words[8].html, '<i>if</i>');
  // "potential." then a 4.44 s pause: "There" starts a paragraph
  assert.deepEqual(paragraphs(html), ['We could be there at the start. Well if you tap into that potential.', 'There has to be more.']);
  assert.ok(html.startsWith('<article><section><p>') && html.endsWith('</p></section></article>'));
});

test('a WebVTT file: the header, a cue id, cue settings, a NOTE and a line break inside a cue are all handled', () => {
  const html = vtt(read('sample.vtt'));
  const words = spans(html);
  assert.equal(words.length, 19);
  assert.deepEqual(words.slice(0, 3).map((w) => [w.html, w.ms]), [['We', 80], ['could', 320], ['be', 560]]);
  assert.equal(words[8].html, '<b>if</b>');
  assert.deepEqual(paragraphs(html), ['We could be there at the start. Well if you tap into that potential.', 'There has to be more.']);
  // the same captions in either form give the same times
  assert.deepEqual(words.map((w) => w.ms), spans(srt(read('sample.srt'))).map((w) => w.ms));
});

test('markup in a cue that is not one of the styling tags stays as text', () => {
  const html = vtt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<script>x</script> <b>bold</b>\n');
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(html.includes('<b>bold</b>'));
});

test('the word list itself: a cue\'s words end where the next starts, the last at the cue\'s end, for the paragraph rule', () => {
  const html = captionWordsToHtml([
    { ms: 0, html: 'One', cueEnd: 1, lastInCue: false },
    { ms: 500, html: 'two.', cueEnd: 1, lastInCue: true },
    { ms: 6000, html: 'Three.', cueEnd: 7, lastInCue: true },
  ]);
  assert.deepEqual(paragraphs(html), ['One two.', 'Three.']);
});

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

// #842 — a WebVTT cue that times its own words with inline timestamps
const { withoutInlineTimes } = require('../../../js/converters/captions.js');
const timed = (cue) => spans(vtt('WEBVTT\n\n' + cue)).map((w) => [w.html, w.ms]);

test('inline timestamps time the words that follow them, and are not kept as text (#842)', () => {
  assert.deepEqual(timed('00:00:01.000 --> 00:00:04.000\none <00:00:02.000>two <00:00:03.500>three\n'),
    [['one', 1000], ['two', 2000], ['three', 3500]]);
});

test('the editor\'s own word-level form, over two lines, with its <c> tags and an escaped word (#842)', () => {
  assert.deepEqual(timed('00:00:01.200 --> 00:00:03.000\n<00:00:01.200><c>So</c> <00:00:01.550><c>if</c>\n'
    + '<00:00:02.000><c>&lt;inaudible&gt;</c> <00:00:02.500><c>you</c>\n'),
    [['So', 1200], ['if', 1550], ['&lt;inaudible&gt;', 2000], ['you', 2500]]);
});

test('a timestamp without hours or spaces round it, words sharing a stretch, and a styling tag round a timed word (#842)', () => {
  assert.deepEqual(timed('00:00:01.000 --> 00:00:04.000\none<00:02.000><c> two three</c> <b><00:03.000>four</b>\n'),
    [['one', 1000], ['two', 2000], ['three', 2500], ['<b>four</b>', 3000]]);
});

test('a timestamp out of order is ignored, and one past the cue is held to its end (#842)', () => {
  assert.deepEqual(timed('00:00:01.000 --> 00:00:04.000\none <00:00:03.000>two <00:00:02.000>three <00:00:09.000>four\n'),
    [['one', 1000], ['two', 3000], ['three', 3500], ['four', 4000]]);
});

test('the captions an import keeps lose the inline timestamps and <c> tags, and nothing else (#842)', () => {
  const file = 'WEBVTT\nKind: captions\n\nNOTE made by hand\n\n1\n00:00:01.200 --> 00:00:03.000 align:start\n'
    + '<00:00:01.200><c>So</c> <00:00:01.550><c.yellow>if</c>\n';
  assert.equal(withoutInlineTimes(file),
    'WEBVTT\nKind: captions\n\nNOTE made by hand\n\n1\n00:00:01.200 --> 00:00:03.000 align:start\nSo if\n');
  // a file without them comes out as it went in, its class spans included
  assert.equal(withoutInlineTimes(read('sample.vtt')), read('sample.vtt'));
  const coloured = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c.yellow>Ann</c> speaks\n';
  assert.equal(withoutInlineTimes(coloured), coloured);
});

// #861 — WebVTT's hours are optional
test('cue times without hours are read, alone or mixed with times that have them (#861)', () => {
  const html = vtt('WEBVTT\n\n00:01.000 --> 00:03.000\none two\n\n00:05.500 --> 01:00:06.000\nthree\n');
  assert.deepEqual(spans(html).map((w) => [w.html, w.ms]), [['one', 1000], ['two', 2000], ['three', 5500]]);
});

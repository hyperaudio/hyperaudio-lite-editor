// Unit tests for the speaker-coloured caption downloads (#536).
// The module is pure string work: it is handed a finished VTT or SRT and one
// speaker name per cue, and decorates. Everything about WHERE the speaker came
// from lives in the editor, so none of it is exercised here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PALETTE, decorateVtt, decorateSrt, assignColours, escapeCueText, sanitiseName, cueStarts } =
  require('../../js/caption-speaker-colours.js');

const VTT = [
  'WEBVTT',
  '',
  '00:00:00.320 --> 00:00:03.600',
  'Hello there',
  '',
  '00:00:03.840 --> 00:00:07.600',
  'and welcome',
  'to the show',
  '',
  '00:00:08.000 --> 00:00:10.000',
  'Thanks for having me',
  '',
].join('\n');

const SRT = [
  '1',
  '00:00:00,320 --> 00:00:03,600',
  'Hello there',
  '',
  '2',
  '00:00:03,840 --> 00:00:07,600',
  'and welcome',
  '',
].join('\n');

test('assignColours: by first appearance, deduped, blanks ignored', () => {
  const colours = assignColours(['Ada', '', 'Grace', 'Ada', null, 'Grace']);
  assert.deepEqual([...colours.keys()], ['Ada', 'Grace']);
  assert.equal(colours.get('Ada'), PALETTE[0]);
  assert.equal(colours.get('Grace'), PALETTE[1]);
});

test('assignColours: cycles past the end of the palette', () => {
  const names = Array.from({ length: PALETTE.length + 2 }, (_, i) => 'S' + i);
  const colours = assignColours(names);
  assert.equal(colours.size, PALETTE.length + 2);
  assert.equal(colours.get('S' + PALETTE.length), PALETTE[0]);
  assert.equal(colours.get('S' + (PALETTE.length + 1)), PALETTE[1]);
});

test('assignColours: no speakers at all gives an empty map', () => {
  assert.equal(assignColours([]).size, 0);
  assert.equal(assignColours(['', '', null]).size, 0);
  assert.equal(assignColours(undefined).size, 0);
});

test('decorateVtt: a STYLE block after the header, one rule per speaker', () => {
  const out = decorateVtt(VTT, ['Ada', 'Ada', 'Grace']);
  const lines = out.split('\n');
  assert.equal(lines[0], 'WEBVTT');
  assert.equal(lines[2], 'STYLE');
  assert.equal(lines[3], `::cue(v[voice="Ada"]) { color: ${PALETTE[0]}; }`);
  assert.equal(lines[4], `::cue(v[voice="Grace"]) { color: ${PALETTE[1]}; }`);
  // and the block sits before the first cue
  assert.ok(out.indexOf('STYLE') < out.indexOf('00:00:00.320'));
});

test('decorateVtt: one voice tag per cue, spanning both lines', () => {
  const out = decorateVtt(VTT, ['Ada', 'Ada', 'Grace']);
  assert.ok(out.includes('<v Ada>Hello there</v>'));
  assert.ok(out.includes('<v Ada>and welcome\nto the show</v>'));
  assert.ok(out.includes('<v Grace>Thanks for having me</v>'));
  // timings are untouched
  assert.ok(out.includes('00:00:03.840 --> 00:00:07.600'));
});

test('decorateVtt: a cue with no speaker is left exactly as it was', () => {
  const out = decorateVtt(VTT, ['Ada', '', 'Grace']);
  assert.ok(out.includes('\nand welcome\nto the show\n'));
  assert.ok(!out.includes('<v >'));
});

test('decorateVtt: no speakers at all returns the input unchanged', () => {
  assert.equal(decorateVtt(VTT, []), VTT);
  assert.equal(decorateVtt(VTT, ['', '', '']), VTT);
});

test('decorateVtt: cue text is escaped inside the markup', () => {
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\na <inaudible> & so on\n';
  const out = decorateVtt(vtt, ['Ada']);
  assert.ok(out.includes('<v Ada>a &lt;inaudible&gt; &amp; so on</v>'));
});

test('sanitiseName: collapses whitespace and escapes what would close the tag', () => {
  assert.equal(sanitiseName('  Ada   Lovelace '), 'Ada Lovelace');
  assert.equal(sanitiseName('A<b>c'), 'A&lt;b&gt;c');
  assert.equal(sanitiseName('line\nbreak'), 'line break');
  assert.equal(sanitiseName(null), '');
});

test('escapeCueText: ampersand first, so an escape is not double-escaped', () => {
  assert.equal(escapeCueText('&<>'), '&amp;&lt;&gt;');
  assert.equal(escapeCueText('a & b'), 'a &amp; b');
});

test('decorateSrt: a font tag per cue, index and timing untouched', () => {
  const out = decorateSrt(SRT, ['Ada', 'Grace']);
  assert.ok(out.includes(`<font color="${PALETTE[0]}">Hello there</font>`));
  assert.ok(out.includes(`<font color="${PALETTE[1]}">and welcome</font>`));
  assert.ok(out.startsWith('1\n00:00:00,320 --> 00:00:03,600\n'));
});

test('decorateSrt: no speakers at all returns the input unchanged', () => {
  assert.equal(decorateSrt(SRT, []), SRT);
});

test('a short speaker list leaves the cues past its end alone', () => {
  const out = decorateVtt(VTT, ['Ada']);
  assert.ok(out.includes('<v Ada>Hello there</v>'));
  assert.ok(out.includes('\nand welcome\nto the show\n'));
  assert.ok(out.includes('\nThanks for having me\n'));
});

test('CRLF input is handled, and a trailing blank line does not eat a cue', () => {
  const out = decorateVtt(VTT.replace(/\n/g, '\r\n'), ['Ada', 'Ada', 'Grace']);
  assert.ok(out.includes('<v Grace>Thanks for having me</v>'));
});

test('a NOTE block does not consume a speaker, so cues stay aligned', () => {
  const vtt = [
    'WEBVTT', '',
    'NOTE this file was hand-checked', '',
    '00:00:00.000 --> 00:00:01.000', 'first', '',
    '00:00:01.000 --> 00:00:02.000', 'second', '',
  ].join('\n');
  const out = decorateVtt(vtt, ['Ada', 'Grace']);
  assert.ok(out.includes('<v Ada>first</v>'));
  assert.ok(out.includes('<v Grace>second</v>'));
  assert.ok(out.includes('NOTE this file was hand-checked'));
});

test('the trailing newline of the input is kept', () => {
  assert.ok(decorateVtt(VTT, ['Ada', 'Ada', 'Grace']).endsWith('</v>\n'));
  assert.ok(decorateSrt(SRT, ['Ada', 'Grace']).endsWith('</font>\n'));
});

test('cueStarts: one start per cue, in order, headers and notes skipped', () => {
  assert.deepEqual(cueStarts(VTT), ['00:00:00.320', '00:00:03.840', '00:00:08.000']);
  assert.deepEqual(cueStarts(SRT), ['00:00:00,320', '00:00:03,840']);
  assert.deepEqual(cueStarts('WEBVTT\n\nNOTE nothing here\n'), []);
  assert.deepEqual(cueStarts(''), []);
});

// #672 — a WebVTT file may carry lines before its first cue: a metadata
// block after WEBVTT (FADGI), a NOTE, the STYLE block our own coloured
// download writes. The caption editor's import appended every one of them
// to a cue that did not exist yet and pushed the lot as a first row with no
// times. Only what follows a timing line is a cue's text now.
import { test, expect } from '@playwright/test';

const rows = (page) => page.evaluate(() => [...document.querySelectorAll('#captions-display .caption')].map((r) => ({
  start: r.querySelector('.start').value, end: r.querySelector('.end').value,
  line1: r.querySelector('.line1').value, line2: r.querySelector('.line2').value,
})));

const FADGI = [
  'WEBVTT',
  'Type: caption',
  'Language: eng',
  'Responsible Party: US, Library of Congress',
  'File Creation Date: 2018-04-21',
  '',
  'NOTE made by hand',
  'and a second note line',
  '',
  'STYLE',
  '::cue(v[voice="Ann"]) { color: #ffe14d; }',
  '',
  'intro',
  '00:00:01.000 --> 00:00:03.000',
  '<v Ann>first line</v>',
  'second line',
  '',
  '00:00:04.000 --> 00:00:05.500 line:90%',
  'last cue',
  '',
].join('\n');

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // rows are only put on screen in caption mode; otherwise they go to a
  // detached holder and only the cache is kept
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
});

test('header lines, NOTE and STYLE blocks and cue identifiers are not caption text (#672)', async ({ page }) => {
  await page.evaluate((vtt) => window.populateCaptionEditorFromVtt(vtt), FADGI);
  const built = await rows(page);
  expect(built).toHaveLength(2);
  expect(built[0]).toMatchObject({ start: '00:00:01.000', end: '00:00:03.000', line1: '<v Ann>first line</v>', line2: 'second line' });
  expect(built[1]).toMatchObject({ start: '00:00:04.000', end: '00:00:05.500', line1: 'last cue', line2: '' });
  // nothing of the header reached a row
  expect(JSON.stringify(built)).not.toMatch(/Type:|NOTE|STYLE|undefined|intro/);
});

test('the parser is the same function under node conditions: CRLF, no trailing newline, one cue (#672)', async ({ page }) => {
  const cues = await page.evaluate(() => window.parseVttCuesForEditor('WEBVTT\r\n\r\n00:00:00.500 --> 00:00:01.000\r\nonly'));
  expect(cues).toEqual([{ start: '00:00:00.500', stop: '00:00:01.000', text: 'only\n' }]);
  expect(await page.evaluate(() => window.parseVttCuesForEditor('WEBVTT\n\nNOTE nothing else\n'))).toEqual([]);
});

test('a plain WebVTT imports exactly as before (#672)', async ({ page }) => {
  const plain = 'WEBVTT\n\n00:00:00.320 --> 00:00:01.500\nBenvenuti a Hyperaudio\nsecond\n\n00:00:02.000 --> 00:00:03.000\nfine\n';
  await page.evaluate((vtt) => window.populateCaptionEditorFromVtt(vtt), plain);
  expect(await rows(page)).toEqual([
    { start: '00:00:00.320', end: '00:00:01.500', line1: 'Benvenuti a Hyperaudio', line2: 'second' },
    { start: '00:00:02.000', end: '00:00:03.000', line1: 'fine', line2: '' },
  ]);
});

test('our own coloured export re-imports with only its cues (#672)', async ({ page }) => {
  const before = await rows(page);
  const coloured = await page.evaluate(() =>
    window.CaptionSpeakerColours.decorateVtt(window.HyperaudioSave.getCaptionsVtt(), window.captionSpeakerList()));
  expect(coloured).toContain('STYLE');
  await page.evaluate((vtt) => window.populateCaptionEditorFromVtt(vtt), coloured);
  const after = await rows(page);
  expect(after).toHaveLength(before.length);
  expect(after.map((r) => r.start)).toEqual(before.map((r) => r.start));
  expect(JSON.stringify(after)).not.toContain('STYLE');
});

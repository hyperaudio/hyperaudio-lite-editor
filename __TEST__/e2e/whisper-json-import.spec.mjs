// #631 — importing Whisper JSON through the dialog: the file is read, the
// dialect sniffed, and the transcript rendered through the canonical
// converter, with the media the dialog was given.
import { test, expect } from '@playwright/test';

const WHISPERX = {
  language: 'en',
  segments: [
    { start: 0.5, end: 1.6, speaker: 'Alice', text: 'hello there world',
      words: [
        { word: 'hello', start: 0.5, end: 0.9, speaker: 'Alice' },
        { word: 'there', start: 1.0, end: 1.3, speaker: 'Alice' },
        { word: 'world.', start: 1.3, end: 1.6, speaker: 'Alice' },
      ] },
    { start: 2.0, end: 2.8, speaker: 'Bob', text: 'hi back',
      words: [
        { word: 'hi', start: 2.0, end: 2.4, speaker: 'Bob' },
        { word: 'back.', start: 2.4, end: 2.8, speaker: 'Bob' },
      ] },
  ],
};

const upload = (page, name, contents) => page.setInputFiles('#whisper-json', {
  name, mimeType: 'application/json', buffer: Buffer.from(contents),
});

const openDialog = (page) => page.evaluate(() => {
  document.getElementById('file-import-whisper-json-dialog').checked = true;
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('the item is in the Import submenu and opens the dialog (#631)', async ({ page }) => {
  const wired = await page.evaluate(() => {
    const label = document.querySelector('#file-import-submenu import-whisper-json label');
    return {
      present: label !== null,
      target: label ? label.getAttribute('for') : null,
      tabbable: label ? label.tabIndex === 0 : false,          // a11y.js wires label-buttons
      toggleHidden: document.getElementById('file-import-whisper-json-dialog').getAttribute('aria-hidden') === 'true',
    };
  });
  expect(wired).toEqual({ present: true, target: 'file-import-whisper-json-dialog', tabbable: true, toggleHidden: true });
});

test('a WhisperX file becomes a transcript with its speakers and timings (#631)', async ({ page }) => {
  await openDialog(page);
  await upload(page, 'whisperx.json', JSON.stringify(WHISPERX));
  await page.fill('#whisper-json-media', 'https://media.example/talk.mp3');
  await page.click('#file-import-whisper-json');

  await expect.poll(() => page.evaluate(() =>
    [...document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')].map((s) => s.textContent.trim())))
    .toEqual(['hello', 'there', 'world.', 'hi', 'back.']);

  const state = await page.evaluate(() => ({
    speakers: [...document.querySelectorAll('#hypertranscript span.speaker')].map((s) => s.textContent.trim()),
    paragraphs: document.querySelectorAll('#hypertranscript p').length,
    firstStart: document.querySelector('#hypertranscript span[data-m]:not(.speaker)').getAttribute('data-m'),
    src: document.getElementById('hyperplayer').src,
    lang: document.getElementById('hyperplayer-vtt').getAttribute('srclang'),
    dialogOpen: document.getElementById('file-import-whisper-json-dialog').checked,
  }));
  expect(state.speakers).toEqual(['[Alice]', '[Bob]']);
  expect(state.paragraphs).toBe(2);
  expect(state.firstStart).toBe('500');                     // 0.5s, in ms
  expect(state.src).toBe('https://media.example/talk.mp3');
  expect(state.lang).toBe('en');
  expect(state.dialogOpen).toBe(false);                     // closes on success

  // and it is a real project transcript: the editor can read it back
  expect(await page.evaluate(() => htmlToJSON(document.getElementById('hypertranscript').innerHTML).words.length)).toBe(5);
});

test('a segment-only file still imports, with word timings spread across it (#631)', async ({ page }) => {
  await openDialog(page);
  await upload(page, 'cli.json', JSON.stringify({
    language: 'en',
    segments: [{ start: 10, end: 13, text: 'incomprehensibility is long' }],
  }));
  await page.click('#file-import-whisper-json');

  await expect.poll(() => page.evaluate(() =>
    [...document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')].map((s) => s.textContent.trim())))
    .toEqual(['incomprehensibility', 'is', 'long']);
  const spans = await page.evaluate(() =>
    [...document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')]
      .map((s) => ({ m: Number(s.getAttribute('data-m')), d: Number(s.getAttribute('data-d')) })));
  expect(spans[0].m).toBe(10000);
  expect(spans[spans.length - 1].m + spans[spans.length - 1].d).toBeLessThanOrEqual(13000);
  expect(spans[0].d).toBeGreaterThan(spans[1].d);   // the long word earns the longer span
});

test('a file that is not Whisper JSON is refused and the transcript left alone (#631)', async ({ page }) => {
  const before = await page.evaluate(() => document.getElementById('hypertranscript').innerHTML);
  await openDialog(page);
  await upload(page, 'notes.json', JSON.stringify({ hello: 'world' }));
  await page.click('#file-import-whisper-json');
  await expect(page.locator('#whisper-json-status')).toContainText('does not look like Whisper JSON');
  expect(await page.evaluate(() => document.getElementById('hypertranscript').innerHTML)).toBe(before);

  await upload(page, 'broken.json', '{ not json');
  await page.click('#file-import-whisper-json');
  await expect(page.locator('#whisper-json-status')).toContainText('not valid JSON');
  expect(await page.evaluate(() => document.getElementById('hypertranscript').innerHTML)).toBe(before);
});

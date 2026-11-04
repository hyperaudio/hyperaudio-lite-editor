// #757 — a transcript imported without media is a text-only project. The
// importers used to leave the previous project's media on the player (the
// JSON imports) or put the empty URL field on it (SRT, VTT), which the browser
// resolves to the page's own address, and the birth read whatever the player
// held as the new project's media: a link to the intro audio, or to
// index.html. Every import is driven here with no file and no URL while the
// intro project plays, and the project born must have no media at all.
import { test, expect } from '@playwright/test';

const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello there\n\n00:00:01.000 --> 00:00:02.000\nfriend\n';
const SRT = '1\n00:00:00,000 --> 00:00:01,000\nHello there\n\n2\n00:00:01,000 --> 00:00:02,000\nfriend\n';
const WHISPERX = { segments: [{ start: 0, end: 1, text: 'hello there', words: [
  { word: 'hello', start: 0, end: 0.5 }, { word: 'there', start: 0.5, end: 1 } ] }] };
const DEEPGRAM = { results: { channels: [{ alternatives: [{ transcript: 'hello there', words: [
  { word: 'hello', punctuated_word: 'hello', start: 0, end: 0.5, speaker: 0 },
  { word: 'there', punctuated_word: 'there', start: 0.5, end: 1, speaker: 0 } ] }] }] } };
const HYPERAUDIO = { words: [{ start: 0, end: 0.5, text: 'hello' }, { start: 0.5, end: 1, text: 'there' }],
  paragraphs: [{ start: 0, end: 1, speaker: null }] };

const file = (name, mimeType, contents) => ({ name, mimeType, buffer: Buffer.from(contents) });

const born = (page) => page.evaluate(async () => {
  const save = window.HyperaudioSave;
  const list = await save.library.list();
  const cur = list.find((e) => String(e.id) === String(save.library.currentId()));
  const p = document.getElementById('hyperplayer');
  return { name: cur && cur.name, kind: cur && cur.media && cur.media.kind, url: cur && cur.media && cur.media.url,
    playerSrc: p.getAttribute('src'), stateKind: (save.captureState() || {}).media.kind };
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(async () => (await window.HyperaudioSave.library.list()).length)).toBe(1);
  // the intro plays from its link: what every import used to inherit
  expect(await page.evaluate(() => document.getElementById('hyperplayer').src)).toContain('HLEintroAudio');
});

async function expectTextOnly(page) {
  await expect.poll(() => page.evaluate(async () => (await window.HyperaudioSave.library.list()).length)).toBe(2);
  // no media, nothing on the player, and the neutral fallback name rather
  // than the intro's, the page's, or the open project's title
  await expect.poll(() => born(page)).toEqual({ name: 'project', kind: 'none', url: '', playerSrc: null, stateKind: 'none' });
}

test('VTT without media is born text-only', async ({ page }) => {
  await page.evaluate(() => { document.getElementById('file-import-vtt-dialog').checked = true; });
  await page.setInputFiles('#vtt', file('captions.vtt', 'text/vtt', VTT));
  await page.click('#file-import-vtt');
  await expect(page.locator('#hypertranscript')).toContainText('Hello there');
  await expectTextOnly(page);
});

test('SRT without media is born text-only', async ({ page }) => {
  await page.evaluate(() => { document.getElementById('file-import-srt-dialog').checked = true; });
  await page.setInputFiles('#srt', file('captions.srt', 'application/x-subrip', SRT));
  await page.click('#file-import-srt');
  await expect(page.locator('#hypertranscript')).toContainText('Hello there');
  await expectTextOnly(page);
});

test('Whisper JSON without media is born text-only', async ({ page }) => {
  await page.evaluate(() => { document.getElementById('file-import-whisper-json-dialog').checked = true; });
  await page.setInputFiles('#whisper-json', file('whisperx.json', 'application/json', JSON.stringify(WHISPERX)));
  await page.click('#file-import-whisper-json');
  await expect(page.locator('#hypertranscript')).toContainText('hello');
  await expectTextOnly(page);
});

test('Deepgram JSON without media is born text-only', async ({ page }) => {
  await page.evaluate(() => { document.getElementById('file-import-deepgram-json-dialog').checked = true; });
  await page.setInputFiles('#deepgram-json', file('deepgram.json', 'application/json', JSON.stringify(DEEPGRAM)));
  await page.click('#file-import-deepgram-json');
  await expect(page.locator('#hypertranscript')).toContainText('hello');
  await expectTextOnly(page);
});

test('Hyperaudio JSON without a media URL is born text-only, after the file is read', async ({ page }) => {
  const chooser = page.waitForEvent('filechooser');
  await page.evaluate(() => document.querySelector('import-json').click());
  await (await chooser).setFiles(file('hyperaudio.json', 'application/json', JSON.stringify(HYPERAUDIO)));
  await expect(page.locator('#hypertranscript')).toContainText('hello');
  await expectTextOnly(page);
});

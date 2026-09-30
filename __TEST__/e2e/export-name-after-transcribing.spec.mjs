// Straight after transcribing from a URL, every download was named
// "hyperaudio-export.*" — the JSON, the captions, the documents. The project
// had no title yet, and the title the downloads read fell back to the
// captured File alone, which URL-mode media has none of; the sanitiser then
// took the '' fallback the download links asked for as no fallback at all.
// Recents, meanwhile, named the project after its URL. One rule now.
import { test, expect } from '@playwright/test';
import { ladderWav } from './helpers.mjs';

const MEDIA = 'https://media.example.com/talks/keynote-2026.mp3';

const transcribeFromUrl = async (page) => {
  await page.route(MEDIA, (route) => route.fulfill({ body: ladderWav(2), contentType: 'audio/wav' }));
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(async (url) => {
    document.querySelector('#hypertranscript').innerHTML = '<div>Transcribing….</div>';
    document.getElementById('hyperplayer').src = url;
    window.setTranscriptBusy(true);
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('#hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="400">Hello </span><span data-m="400" data-d="400">there </span></p></section></article>';
    window.setTranscriptBusy(false);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  }, MEDIA);
  // the birth has landed once Recents lists it
  await expect.poll(() => page.evaluate(async () => {
    const save = window.HyperaudioSave;
    const cur = (await save.library.list()).find((e) => String(e.id) === String(save.library.currentId()));
    return cur ? cur.name : null;
  })).toBe('keynote-2026.mp3');
};

const downloadName = async (page, click) => {
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(click);
  return (await downloadPromise).suggestedFilename();
};

test('downloads straight after transcribing from a URL are named after the media, as Recents is', async ({ page }) => {
  await transcribeFromUrl(page);
  expect(await page.evaluate(() => window.HyperaudioSave.getProjectTitle())).toBe('keynote-2026.mp3');
  expect(await downloadName(page, () => document.querySelector('export-json a').click())).toBe('keynote-2026.mp3.json');
  expect(await downloadName(page, () => document.getElementById('download-vtt').click())).toBe('keynote-2026.mp3.vtt');
  expect(await downloadName(page, () => document.getElementById('export-transcript-txt').click())).toBe('keynote-2026.mp3.txt');
});

test('a project with no title and no media keeps the names its markup gives', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // a text-only birth: no source in the player
  await page.evaluate(() => {
    document.getElementById('hyperplayer').removeAttribute('src');
    document.querySelector('#hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="400">Hello </span></p></section></article>';
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  });
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.getProjectTitle())).toBe('');
  expect(await downloadName(page, () => document.querySelector('export-json a').click())).toBe('hyperaudio-lite.json');
  expect(await downloadName(page, () => document.getElementById('download-vtt').click())).toBe('hyperaudio.vtt');
});

// A cloud recording is still arriving while it is transcribed, so the player
// never decodes a frame from it. The picture frozen at loadstart to cover the
// gap — the PREVIOUS project's — then stayed for good: URL media stores no
// file, so the capture pipeline can never answer for it, and nothing else
// replaced it. The project wore the last recording's picture while Recents
// drew its glyph beside it.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const CLOUD_URL = 'https://cdn.example.com/recordings/cloud-recording.mp4';

// Transcribe in the engines' own order: the media on the player, then the busy
// signal, then the transcript and hyperaudioInit.
const transcribe = (page, src, word) => page.evaluate(async ([url, text]) => {
  document.querySelector('#hypertranscript').innerHTML = '<div>Transcribing….</div>';
  document.getElementById('hyperplayer').src = url;
  window.setTranscriptBusy(true);
  await new Promise((r) => setTimeout(r, 900));
  document.querySelector('#hypertranscript').innerHTML =
    `<article><section><p><span data-m='0' data-d='400'>${text} </span>`
    + `<span data-m='400' data-d='400'>two </span></p></section></article>`;
  window.setTranscriptBusy(false);
  document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
}, [src, word]);

// Which project's picture the player is wearing, named rather than compared by
// hand: a glyph is derived from the entry, a capture is whatever is showing.
const posterOwner = (page) => page.evaluate(async () => {
  const showing = document.getElementById('hyperplayer').getAttribute('poster') || '';
  const list = await window.HyperaudioSave.library.list();
  const glyph = list.find((e) => window.MediaPosters.glyphUrl(e) === showing);
  return {
    glyphOf: glyph === undefined ? null : glyph.name,
    current: (list.find((e) => String(e.id) === String(window.HyperaudioSave.library.currentId())) || {}).name || null,
    scheme: showing.slice(0, showing.indexOf(':') + 1),
  };
});

test('a cloud recording that never decodes a frame does not keep the last project\'s picture', async ({ page }) => {
  const video = readFileSync(join(FIXTURES, 'video-640x360.mp4'));
  // the cloud recording answers only after the transcription is over
  await page.route(CLOUD_URL, async (route) => {
    await new Promise((r) => setTimeout(r, 6000));
    await route.fulfill({ status: 200, contentType: 'video/mp4', body: video });
  });

  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  // a first project, with a picture of its own
  await transcribe(page, '/__TEST__/fixtures/video-640x360.mp4', 'First');
  await expect.poll(async () => (await posterOwner(page)).current).toBe('video-640x360.mp4');
  await expect.poll(async () => (await posterOwner(page)).scheme).toBe('blob:');
  const first = await page.evaluate(() => document.getElementById('hyperplayer').getAttribute('poster'));

  // then the cloud recording, which is still downloading throughout
  await transcribe(page, CLOUD_URL, 'Second');
  await expect.poll(async () => (await posterOwner(page)).current).toBe('cloud-recording.mp4');

  // the new project wears its own glyph, the picture Recents draws for it,
  // rather than the previous recording's frame
  await expect.poll(async () => (await posterOwner(page)).glyphOf).toBe('cloud-recording.mp4');
  expect(await page.evaluate(() => document.getElementById('hyperplayer').getAttribute('poster'))).not.toBe(first);
  expect(await page.evaluate(() => document.getElementById('hyperplayer').readyState)).toBe(0);
});

test('a recording that does decode a frame keeps that frame, not a glyph', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  await transcribe(page, '/__TEST__/fixtures/video-640x360.mp4', 'First');
  await expect.poll(async () => (await posterOwner(page)).current).toBe('video-640x360.mp4');

  await transcribe(page, '/__TEST__/fixtures/video-320x240.mp4', 'Second');
  await expect.poll(async () => (await posterOwner(page)).current).toBe('video-320x240.mp4');

  // its own picture, at its own size — the glyph is the fallback, not the rule
  await expect.poll(async () => (await posterOwner(page)).glyphOf).toBe(null);
  const size = await page.evaluate(() => new Promise((done) => {
    const img = new Image();
    img.onload = () => done(img.naturalWidth + 'x' + img.naturalHeight);
    img.onerror = () => done('?');
    img.src = document.getElementById('hyperplayer').getAttribute('poster') || '';
  }));
  expect(size).not.toBe('?');
  expect(size.startsWith('320x')).toBe(true);
});

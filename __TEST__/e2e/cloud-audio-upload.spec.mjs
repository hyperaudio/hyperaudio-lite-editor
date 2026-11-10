// A video picked for a cloud engine goes up as its sound only (#788): 16 kHz
// mono Opus in an Ogg file, named after the video, through all three cloud clients. An audio
// file goes up as it is. A 54-minute video of 527 MB failed at DeepInfra
// after minutes of upload, where its audio is about 20 MB.
import { test, expect } from '@playwright/test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { ladderWav } from './helpers.mjs';

const VIDEO = new URL('../fixtures/video-640x360.mp4', import.meta.url);
const VIDEO_BYTES = statSync(VIDEO).size;
const NEMOTRON = readFileSync(new URL('../fixtures/converters/nemotron.json', import.meta.url), 'utf8');

// the file part of a multipart body: its name and type
const filePart = (buffer) => {
  const m = /filename="([^"]+)"\r\nContent-Type: ([^\r\n]+)\r\n\r\n/.exec(buffer.toString('latin1'));
  return m ? { filename: m[1], type: m[2] } : null;
};
// an Ogg file starts with its capture pattern
const looksLikeOgg = (buffer) => buffer.subarray(0, 4).toString('latin1') === 'OggS';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.library.currentId())).not.toBeNull();
});

// Playwright's copy of a multipart body leaves the file's bytes out, so the
// file part is read off the FormData on its way into fetch
const watchUploads = (page) => page.evaluate(() => {
  const original = window.fetch;
  window.__sent = null;
  window.fetch = (url, init) => {
    if (init && init.body instanceof FormData) {
      const file = init.body.get('file') || init.body.get('audio');
      if (file) window.__sent = { name: file.name, type: file.type, size: file.size };
    }
    return original(url, init);
  };
});

test('hugging face: a video goes up as 16 kHz mono opus named after it, and the transcript lands', async ({ page, context }) => {
  let header = null;
  await context.route('https://router.huggingface.co/**', (route) => {
    header = { type: route.request().headers()['content-type'], part: filePart(route.request().postDataBuffer()) };
    route.fulfill({ status: 200, contentType: 'application/json', body: NEMOTRON });
  });
  await page.setInputFiles('#parakeet-hf-file', VIDEO.pathname);
  await watchUploads(page);
  await page.evaluate(() => {
    document.querySelector('#parakeet-hf-key').value = 'hf_not-a-token';
    document.querySelector('parakeet-hf-service').getData();
  });
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible({ timeout: 30000 });
  expect(header.type).toMatch(/^multipart\/form-data/);
  expect(header.part).toEqual({ filename: 'video-640x360.ogg', type: 'audio/ogg' });
  const sent = await page.evaluate(() => window.__sent);
  expect(sent).toMatchObject({ name: 'video-640x360.ogg', type: 'audio/ogg' });
  expect(sent.size).toBeGreaterThan(1000);            // a second of sound
  expect(sent.size).toBeLessThan(VIDEO_BYTES / 2);    // and no picture

  // the player and the project keep the video: only the upload was converted
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.library.currentId())).not.toBeNull();
  const kept = await page.evaluate(async () => {
    const rows = await window.HyperaudioSave.library.list();
    const row = rows.find((r) => r.id === window.HyperaudioSave.library.currentId());
    const media = await (await fetch(document.getElementById('hyperplayer').src)).blob();
    return { name: row ? row.name : null, size: media.size, type: media.type };
  });
  expect(kept).toEqual({ name: 'video-640x360.mp4', size: VIDEO_BYTES, type: 'video/mp4' });
});

test('hugging face: an audio file goes up as it is', async ({ page, context }, testInfo) => {
  const wav = testInfo.outputPath('clip.wav');
  const bytes = ladderWav(1);
  writeFileSync(wav, bytes);
  await context.route('https://router.huggingface.co/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: NEMOTRON }));
  await page.setInputFiles('#parakeet-hf-file', wav);
  await watchUploads(page);
  await page.evaluate(() => {
    document.querySelector('#parakeet-hf-key').value = 'hf_not-a-token';
    document.querySelector('parakeet-hf-service').getData();
  });
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible({ timeout: 30000 });
  expect(await page.evaluate(() => window.__sent)).toEqual({ name: 'clip.wav', type: 'audio/wav', size: bytes.length });
});

test('assemblyai: the upload is the video\'s sound as opus', async ({ page, context }) => {
  let sent = null;
  await context.route('https://api.assemblyai.com/**', (route) => {
    if (route.request().url().endsWith('/upload')) {
      sent = { body: route.request().postDataBuffer(), type: route.request().headers()['content-type'] };
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });   // enough: the upload is the point
    }
    return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
  });
  await page.setInputFiles('#assemblyai-file', VIDEO.pathname);
  await page.evaluate(() => {
    document.querySelector('#assemblyai-key').value = 'not-a-key';
    document.querySelector('assemblyai-service').getData();
  });
  await expect.poll(() => sent !== null, { timeout: 30000 }).toBe(true);
  expect(sent.type).toBe('audio/ogg');
  expect(looksLikeOgg(sent.body)).toBe(true);
  expect(sent.body.length).toBeLessThan(VIDEO_BYTES);
});

test('deepgram: the upload is the video\'s sound as opus', async ({ page, context }) => {
  let sent = null;
  await context.route('https://api.deepgram.com/**', (route) => {
    sent = { body: route.request().postDataBuffer(), type: route.request().headers()['content-type'] };
    return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
  });
  await page.setInputFiles('#deepgram-file', VIDEO.pathname);
  await page.evaluate(() => {
    document.querySelector('#token').value = 'not-a-token';
    document.querySelector('deepgram-service').getData();
  });
  await expect.poll(() => sent !== null, { timeout: 30000 }).toBe(true);
  expect(sent.type).toBe('audio/ogg');
  expect(looksLikeOgg(sent.body)).toBe(true);
  expect(sent.body.length).toBeLessThan(VIDEO_BYTES);
});

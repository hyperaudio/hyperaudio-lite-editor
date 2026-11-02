// #758 — the Deepgram JSON import with a local media file. The importer read
// the file into memory and copied it before putting it on the player, after
// the JSON had been parsed and the project born, so a video of any size left
// the project saved with the previous project's media. The file goes on the
// player first now, as the SRT and VTT imports do since #738.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { pollPage } from './helpers.mjs';

const DEEPGRAM = { results: { channels: [{ alternatives: [{ transcript: 'hello there', words: [
  { word: 'hello', punctuated_word: 'hello', start: 0, end: 0.5, speaker: 0 },
  { word: 'there', punctuated_word: 'there', start: 0.5, end: 1, speaker: 0 } ] }] }] } };

const WHISPERX = { segments: [{ start: 0, end: 1, text: 'hello there', words: [
  { word: 'hello', start: 0, end: 0.5 }, { word: 'there', start: 0.5, end: 1 } ] }] };

test.beforeEach(async ({ page }) => {
  // what the player holds at the moment of the birth, as the save module reads it
  await page.addInitScript(() => {
    document.addEventListener('hyperaudioInit', () => {
      window.__srcAtBirth = document.getElementById('hyperplayer').src;
    }, true);
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(async () => (await window.HyperaudioSave.library.list()).length)).toBe(1);
  expect(await page.evaluate(() => document.getElementById('hyperplayer').src)).toContain('HLEintroAudio');
});

const born = (page) => page.evaluate(async () => {
  const save = window.HyperaudioSave;
  const list = await save.library.list();
  const cur = list.find((e) => String(e.id) === String(save.library.currentId()));
  return { name: cur.name, kind: cur.media && cur.media.kind, filename: cur.media && cur.media.filename,
    srcAtBirth: String(window.__srcAtBirth).slice(0, 5), player: document.getElementById('hyperplayer').src.slice(0, 5) };
});

test('a Deepgram JSON import with a local video is born with that video', async ({ page }, testInfo) => {
  const video = testInfo.outputPath('interview.mp4');
  fs.copyFileSync('__TEST__/fixtures/video-640x360.mp4', video);
  await page.evaluate(() => { document.getElementById('file-import-deepgram-json-dialog').checked = true; });
  await page.setInputFiles('#deepgram-json-file', video);
  await page.setInputFiles('#deepgram-json', { name: 'deepgram.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(DEEPGRAM)) });
  await page.click('#file-import-deepgram-json');
  await expect(page.locator('#hypertranscript')).toContainText('hello');

  // its own video on the player AT the birth, and recorded as the project's
  // own file under its own name, never the intro link the player held before
  await pollPage(page, async () => (await window.HyperaudioSave.library.list()).length === 2);
  expect(await born(page)).toEqual({ name: 'interview.mp4', kind: 'original', filename: 'interview.mp4', srcAtBirth: 'blob:', player: 'blob:' });
});

// The Whisper JSON import put its file on the player in time, but the save
// module did not capture the file from its input, so the project's media was
// resolved later from the player and named "media.mp4". The capture list now
// has both JSON imports' file inputs.
test('a Whisper JSON import with a local video keeps the file\'s name', async ({ page }, testInfo) => {
  const video = testInfo.outputPath('talk.mp4');
  fs.copyFileSync('__TEST__/fixtures/video-640x360.mp4', video);
  await page.evaluate(() => { document.getElementById('file-import-whisper-json-dialog').checked = true; });
  await page.setInputFiles('#whisper-json-file', video);
  await page.setInputFiles('#whisper-json', { name: 'whisperx.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(WHISPERX)) });
  await page.click('#file-import-whisper-json');
  await expect(page.locator('#hypertranscript')).toContainText('hello');
  await pollPage(page, async () => (await window.HyperaudioSave.library.list()).length === 2);
  expect(await born(page)).toEqual({ name: 'talk.mp4', kind: 'original', filename: 'talk.mp4', srcAtBirth: 'blob:', player: 'blob:' });
});

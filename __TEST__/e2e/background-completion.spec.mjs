// #715 — a transcription that finishes while the user is in another project
// used to take the screen: the engines write their result straight into the
// transcript, so the open project was replaced, the player moved to the new
// media, and anything typed inside the autosave delay was lost. It is now
// saved to Recents as a project of its own, and the screen stays put.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ladderWav, pollPage } from './helpers.mjs';

const RESULT = '<article><section><p><span data-m="0" data-d="400">Finished </span>'
  + '<span data-m="500" data-d="400">elsewhere </span></p></section></article>';

// an engine starts, exactly as they all do: the user's file, its media on the
// player, loader markup, then busy(true)
async function startEngine(page, testInfo, name) {
  const wav = testInfo.outputPath(name);
  fs.writeFileSync(wav, ladderWav(1));
  await page.setInputFiles('#file-input', wav);
  await page.evaluate(async (bytes) => {
    const player = document.getElementById('hyperplayer');
    player.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }));
    document.querySelector('#hypertranscript').innerHTML =
      '<div class="vertically-centre"><center><span class="transcribing-msg">Transcribing…</span></center></div>';
    setTranscriptBusy(true);
  }, [...fs.readFileSync(wav)]);
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(1);
}

const library = (page) => page.evaluate(() => window.HyperaudioSave.library.list());

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await pollPage(page, async () => (await window.HyperaudioSave.library.list()).length === 1);
});

test('finishing while another project is open saves it to Recents and leaves the screen alone', async ({ page }, testInfo) => {
  const homeId = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await startEngine(page, testInfo, 'new-recording.wav');
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), homeId);
  await page.waitForSelector('#hypertranscript [data-m]');
  const homeSrc = await page.evaluate(() => document.getElementById('hyperplayer').src);

  // the user is mid-edit when the engine finishes
  await page.locator('#hypertranscript span[data-m]:not(.speaker)').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('ZZEDITZZ');
  const took = await page.evaluate((html) => {
    setTranscriptionInfo({ service: 'TestEngine', model: 'tiny', seconds: 3, language: 'English', languageCode: 'en' });
    setTranscriptBusy(false);
    return window.hyperaudioKeepTranscription({ html });
  }, RESULT);
  expect(took).toBe(true);

  await expect.poll(async () => (await library(page)).length).toBe(2);
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.classList.contains('ha-transcribing'))).toBe(false);
  await expect(page.locator('#project-progress')).toContainText('new-recording.wav');

  // the screen: same project, same media, the edit still there and still typed into
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(homeId);
  expect(await page.evaluate(() => document.getElementById('hyperplayer').src)).toBe(homeSrc);
  await expect(page.locator('#hypertranscript')).toContainText('ZZEDITZZ');
  await expect(page.locator('#hypertranscript')).not.toContainText('Finished');
  await page.keyboard.type('MORE');
  await expect(page.locator('#hypertranscript')).toContainText('ZZEDITZZMORE');
  // and the open project's own details are not the engine's
  expect(await page.evaluate(() => (window.HyperaudioSave.getProvenance() || {}).engine)).not.toBe('testengine');

  // the new project: named after its file, not what a reload returns to
  const born = (await library(page)).find((p) => p.id !== homeId);
  expect(born.name).toBe('new-recording.wav');
  expect(born.media.kind).toBe('original');
  expect(born.media.filename).toBe('new-recording.wav');
  expect(born.media.durationSeconds).toBeGreaterThan(0.5);
  expect(born.lastActiveAt).toBe(0);

  // opening it gives the transcript, its media, its captions and its details
  await page.waitForTimeout(1700); // the home project's edit reaches its draft
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), born.id);
  await expect(page.locator('#hypertranscript')).toContainText('Finished elsewhere');
  await expect.poll(() => page.evaluate(() => document.getElementById('hyperplayer').duration)).toBeGreaterThan(0.5);
  const details = await page.evaluate(() => window.HyperaudioSave.getProvenance());
  expect(details.engine).toBe('testengine');
  expect(details.mediaFile).toBe('new-recording.wav');
  expect(await page.evaluate(() => window.HyperaudioSave.getProjectLanguage())).toBe('en');
  await expect.poll(() => page.evaluate(() => {
    const track = document.getElementById('hyperplayer-vtt');
    return track !== null && track.src.startsWith('data:') && decodeURIComponent(track.src).includes('Finished');
  })).toBe(true);

  // and the project that was being edited kept every keystroke
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), homeId);
  await expect(page.locator('#hypertranscript')).toContainText('ZZEDITZZMORE');
});

test('finishing while its own view is on screen lands there, as it always did', async ({ page }, testInfo) => {
  await startEngine(page, testInfo, 'watched.wav');
  expect(await page.evaluate(() => window.hyperaudioTranscriptionInBackground())).toBe(false);
  expect(await page.evaluate((html) => window.hyperaudioKeepTranscription({ html }), RESULT)).toBe(false);
  // away and back again: watching once more
  const homeId = await page.evaluate(async () => (await window.HyperaudioSave.library.list())[0].id);
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), homeId);
  await page.waitForSelector('#hypertranscript [data-m]');
  expect(await page.evaluate(() => window.hyperaudioTranscriptionInBackground())).toBe(true);
  await page.locator('.recents-transcribing-item').click();
  await expect(page.locator('#hypertranscript')).toContainText('Transcribing…');
  expect(await page.evaluate(() => window.hyperaudioTranscriptionInBackground())).toBe(false);
  await page.evaluate((html) => {
    document.querySelector('#hypertranscript').innerHTML = html;
    setTranscriptBusy(false);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  }, RESULT);
  await expect.poll(async () => (await library(page)).length).toBe(2);
  await expect(page.locator('#hypertranscript')).toContainText('Finished elsewhere');
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).not.toBe(homeId);
});

test('an engine finishing off screen writes nothing to the open project (Deepgram: summary, topics, transcript)', async ({ page }, testInfo) => {
  const homeId = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await startEngine(page, testInfo, 'interview.wav');
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), homeId);
  await page.waitForSelector('#hypertranscript [data-m]');
  const before = await page.evaluate(() => ({
    text: document.querySelector('#hypertranscript').textContent,
    summary: document.querySelector('#summary').textContent,
    topics: document.querySelector('#topics').textContent,
    src: document.getElementById('hyperplayer').src,
  }));
  await page.evaluate(() => parseData({
    metadata: {},
    results: {
      summary: { short: 'A talk about tides.' },
      topics: { segments: [{ topics: [{ topic: 'Tides' }] }] },
      channels: [{ detected_language: 'en', alternatives: [{ words: [
        { word: 'high', punctuated_word: 'High', start: 0.1, end: 0.4, speaker: 0 },
        { word: 'water', punctuated_word: 'water.', start: 0.5, end: 0.9, speaker: 0 },
      ] }] }],
    },
  }));
  await expect.poll(async () => (await library(page)).length).toBe(2);
  const after = await page.evaluate(() => ({
    text: document.querySelector('#hypertranscript').textContent,
    summary: document.querySelector('#summary').textContent,
    topics: document.querySelector('#topics').textContent,
    src: document.getElementById('hyperplayer').src,
  }));
  expect(after).toEqual(before);
  const born = (await library(page)).find((p) => p.id !== homeId);
  expect(born.name).toBe('interview.wav');
  expect(born.summary).toBe('A talk about tides.');
  expect(born.topics).toEqual(['Tides']);
});

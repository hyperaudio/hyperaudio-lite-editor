// #763 — what a failed transcription leaves behind. The error card has the
// screen, so no project owns it: the previous project's row no longer lights
// up as if the error were its, and its lock is let go. The advice on the
// card fits the step that failed: nothing to add when the media could not be
// read, "could not be downloaded" when the model's files did not arrive.
import { test, expect } from '@playwright/test';
import { ladderWav } from './helpers.mjs';

const DEAD_URL = 'https://dead.example.com/items/clip.mp3';

const startWhisperFromUrl = (page, url) => page.evaluate((url) => {
  const field = document.querySelector('#media');
  field.value = url;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#form-submit-btn').click();
  // the submit label toggles the dialog, which was closed: closed again
  document.getElementById('transcribe-modal').checked = false;
}, url);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.library.currentId())).not.toBeNull();
});

test('a URL that cannot be read leaves no project selected, and no advice about the model', async ({ page, context }) => {
  test.setTimeout(90000);
  await context.route('**/js/whisper.worker.js*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await page.route(DEAD_URL, () => { /* never answered */ });
  const before = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await startWhisperFromUrl(page, DEAD_URL);
  // the loader row is the selection while it runs
  await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveClass(/active/);
  await expect(page.locator('#file-picker .file-item[data-id].active')).toHaveCount(0);

  const card = page.locator('#hypertranscript');
  await expect(card).toContainText('network error', { timeout: 40000 });
  await expect(card).not.toContainText('smaller model');
  await expect(card).not.toContainText('reload the page');
  // the error card owns the screen: the previous project's row stays unlit,
  // the loader row is gone, and the session points at nothing
  await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveCount(0);
  await expect(page.locator('#file-picker .file-item.active')).toHaveCount(0);
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBeNull();
  // and that project opens again from Recents, whole
  await page.locator(`#file-picker .file-item[data-id="${before}"]`).click();
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(before);
});

test('an error arriving after the user has moved to a project leaves that project selected', async ({ page, context }) => {
  test.setTimeout(90000);
  await context.route('**/js/whisper.worker.js*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await page.route(DEAD_URL, () => { /* never answered */ });
  const id = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await startWhisperFromUrl(page, DEAD_URL);
  await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveClass(/active/);
  // back to the project while the engine waits on the host
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), id);
  await expect(page.locator('#file-picker .file-item[data-id].active')).toHaveCount(1);
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();

  // the error ends the loader row, and nothing else changes on screen: the
  // card is not painted over the project, the corner notice says what it
  // would have said
  await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveCount(0, { timeout: 40000 });
  await expect(page.locator('#file-picker .file-item[data-id].active')).toHaveCount(1);
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(id);
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();
  await expect(page.locator('#hypertranscript')).not.toContainText('Transcription failed');
  await expect(page.locator('#transcript-ready-notice')).toContainText('“clip.mp3” was not transcribed. Could not fetch the media');
  // and the engine is free for the next run
  expect(await page.evaluate(() => document.documentElement.classList.contains('ha-transcribing'))).toBe(false);
});

test('a model whose files cannot be downloaded says so, not that a smaller one might work', async ({ page, context }, testInfo) => {
  // every request to the model host refused, the way a dead connection or a
  // rate limit reaches the page: a fetch that fails, with no status to read
  await context.route('https://huggingface.co/**', (route) => route.abort());
  const wavPath = testInfo.outputPath('tone.wav');
  (await import('node:fs')).writeFileSync(wavPath, ladderWav(2));
  await page.setInputFiles('#file-input', wavPath);
  await page.evaluate(() => document.getElementById('form-submit-btn').click());
  const card = page.locator('#hypertranscript');
  await expect(card).toContainText('Transcription failed', { timeout: 60000 });
  await expect(card).toContainText('could not be downloaded');
  await expect(card).not.toContainText('smaller model');
  await expect(page.locator('#file-picker .file-item.active')).toHaveCount(0);
});

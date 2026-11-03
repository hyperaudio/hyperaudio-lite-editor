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

// #764 — the cloud engines painted their error cards straight into the
// transcript, so none of the above reached them. Each failure is the API's
// own refusal, routed, with the media host never answering the player.
const CLOUD = {
  deepgram: {
    api: 'https://api.deepgram.com/**', media: 'https://dg.example.com/items/clip.mp3',
    start: () => {
      document.querySelector('#token').value = 'not-a-token';
      document.querySelector('#deepgram-media').value = 'https://dg.example.com/items/clip.mp3';
      document.querySelector('deepgram-service').getData();
    },
    says: 'the token is invalid',
  },
  assemblyai: {
    api: 'https://api.assemblyai.com/**', media: 'https://aai.example.com/items/clip.mp3',
    start: () => {
      document.querySelector('#assemblyai-key').value = 'not-a-key';
      document.querySelector('#assemblyai-media').value = 'https://aai.example.com/items/clip.mp3';
      document.querySelector('assemblyai-service').getData();
    },
    says: 'The API key appears to be invalid',
  },
  'parakeet-hf': {
    api: 'https://router.huggingface.co/**', media: 'https://hf.example.com/items/clip.mp3',
    start: () => {
      document.querySelector('#parakeet-hf-key').value = 'not-a-token';
      document.querySelector('#parakeet-hf-media').value = 'https://hf.example.com/items/clip.mp3';
      document.querySelector('parakeet-hf-service').getData();
    },
    says: 'The HuggingFace token appears to be invalid',
  },
};

for (const [engine, cloud] of Object.entries(CLOUD)) {
  test(`${engine}: a refused request leaves no project selected (#764)`, async ({ page, context }) => {
    // the refusal takes a moment, long enough for the loader row to be seen
    await context.route(cloud.api, async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
    });
    if (engine === 'parakeet-hf') {
      // this engine fetches the media itself and forwards it, so the host answers
      await page.route(cloud.media, (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: ladderWav(1) }));
    } else {
      await page.route(cloud.media, () => { /* never answered */ });
    }
    const before = await page.evaluate(() => window.HyperaudioSave.library.currentId());
    await page.evaluate(cloud.start);
    await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveClass(/active/);

    const card = page.locator('#hypertranscript');
    await expect(card).toContainText(cloud.says, { timeout: 20000 });
    await expect(card.locator('[data-transcript-notice]')).toHaveCount(1);
    await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveCount(0);
    await expect(page.locator('#file-picker .file-item.active')).toHaveCount(0);
    expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBeNull();
    expect(await page.evaluate(() => document.documentElement.classList.contains('ha-transcribing'))).toBe(false);
    // and that project opens again from Recents, whole
    await page.locator(`#file-picker .file-item[data-id="${before}"]`).click();
    await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();
    expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(before);
  });
}

test('a cloud refusal arriving after the user has moved to a project becomes a notice, not a card (#764)', async ({ page, context }) => {
  const cloud = CLOUD.assemblyai;
  await context.route(cloud.api, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
  });
  await page.route(cloud.media, () => { /* never answered */ });
  const id = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await page.evaluate(cloud.start);
  await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveClass(/active/);
  // back to the project while the API thinks it over
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), id);
  await expect(page.locator('#file-picker .file-item[data-id].active')).toHaveCount(1);
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();

  await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveCount(0, { timeout: 20000 });
  await expect(page.locator('#file-picker .file-item[data-id].active')).toHaveCount(1);
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(id);
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();
  await expect(page.locator('#hypertranscript')).not.toContainText('API key');
  await expect(page.locator('#transcript-ready-notice')).toContainText('“clip.mp3” was not transcribed. The API key appears to be invalid');
  expect(await page.evaluate(() => document.documentElement.classList.contains('ha-transcribing'))).toBe(false);
});

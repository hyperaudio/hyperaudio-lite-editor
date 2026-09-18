// A URL transcription took the OPEN project's name and its media. The save
// module captures what is being transcribed at the engine's busy signal — the
// player's media and the File behind it — so a completion arriving after the
// user has switched away is still filed against the right project. The three
// cloud engines raised that signal before putting the URL on the player, so
// the capture took the outgoing project's media, named the new project after
// it, and put its src back on the player when the transcript landed.
import { test, expect } from '@playwright/test';

const MEDIA_URL = 'https://example.com/media/interview-with-ada.mp4';

// The smallest response each cloud engine will parse into three words.
const DEEPGRAM_JSON = {
  results: {
    channels: [{
      detected_language: 'en',
      alternatives: [{
        transcript: 'Brand new words.',
        words: [
          { word: 'brand', start: 0, end: 0.5, speaker: 0 },
          { word: 'new', start: 0.5, end: 1, speaker: 0 },
          { word: 'words', start: 1, end: 1.5, speaker: 0 },
        ],
      }],
    }],
  },
};

const libraryNames = (page) => page.evaluate(async () =>
  (await window.HyperaudioSave.library.list()).map((e) => e.name));

const playerSrc = (page) => page.evaluate(() => document.getElementById('hyperplayer').src);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // the intro project is open, with its own media on the player
  await expect.poll(() => libraryNames(page)).toEqual(['How to use the Editor']);
});

test('a Deepgram URL transcription is named after its own media, not the open project', async ({ page }) => {
  await page.route('https://api.deepgram.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEEPGRAM_JSON) }));

  const openMedia = await playerSrc(page);
  expect(openMedia).not.toContain('interview-with-ada');

  await page.evaluate((url) => {
    document.getElementById('transcribe-modal').checked = true;
    document.querySelector('#token').value = 'test-token';
    const media = document.querySelector('#deepgram-media');
    media.value = url;
    media.dispatchEvent(new Event('input', { bubbles: true }));
  }, MEDIA_URL);

  // the row for the transcription in flight names what is BEING transcribed
  await page.evaluate(() => document.querySelector('#transcribe-btn').click());
  await expect.poll(() => libraryNames(page)).toContain('interview-with-ada.mp4');

  // and the finished project keeps that name, with its own media still on the
  // player rather than the project that was open when it started
  await expect.poll(() => page.evaluate(() =>
    document.querySelectorAll('#hypertranscript span[data-m]').length)).toBeGreaterThan(0);
  await expect.poll(() => libraryNames(page)).toEqual(['interview-with-ada.mp4', 'How to use the Editor']);
  expect(await playerSrc(page)).toBe(MEDIA_URL);
});

test('the engines put the media on the player before they signal busy', async ({ page }) => {
  // The contract, checked directly: at the moment the engine says it is busy,
  // the player must already hold what is being transcribed. Every cloud engine
  // is driven through the same observation.
  const engines = await page.evaluate(async (url) => {
    const results = [];
    const player = document.getElementById('hyperplayer');
    const original = window.setTranscriptBusy;
    for (const engine of [
      { name: 'Deepgram', key: '#token', media: '#deepgram-media', button: '#transcribe-btn' },
      { name: 'AssemblyAI', key: '#assemblyai-key', media: '#assemblyai-media', button: '#assemblyai-submit-btn' },
      { name: 'Parakeet (HF)', key: '#parakeet-hf-key', media: '#parakeet-hf-media', button: '#parakeet-hf-submit-btn' },
    ]) {
      const button = document.querySelector(engine.button);
      const keyField = document.querySelector(engine.key);
      const mediaField = document.querySelector(engine.media);
      if (button === null || keyField === null || mediaField === null) {
        results.push({ name: engine.name, srcAtBusy: 'NOT FOUND' });
        continue;
      }
      player.src = 'https://example.com/media/previous-project.mp4';
      keyField.value = 'test-token';
      mediaField.value = url;
      mediaField.dispatchEvent(new Event('input', { bubbles: true }));
      let srcAtBusy = null;
      window.setTranscriptBusy = function (busy) {
        if (busy === true && srcAtBusy === null) srcAtBusy = player.src;
        // swallow: this probe must not start a real transcription's bookkeeping
      };
      try { button.click(); } catch (e) { /* the network call is not the point */ }
      window.setTranscriptBusy = original;
      results.push({ name: engine.name, srcAtBusy });
    }
    return results;
  }, MEDIA_URL);

  engines.forEach((e) => expect(`${e.name}: ${e.srcAtBusy}`).toBe(`${e.name}: ${MEDIA_URL}`));
});

// Interactive-transcript export: the "Media file or URL" field must reference the
// CURRENT media — a local file's real name, a plain remote URL, or an HLS source's
// original URL — and never a value left over from a previous clip.
//
// A local upload is a blob: URL and an HLS source is a blob: MediaSource URL, so
// neither carries a usable reference in player.src; those are stamped on
// #hyperplayer.dataset.mediaRef (the filename by the central file-input capture,
// the URL by attachMediaPlayback). guessMediaSrc prefers an http(s) src (so a fresh
// remote URL always wins) and otherwise uses the stamped ref. The dialog refreshes
// the field to the current media every time it opens.
import { test, expect } from '@playwright/test';

const loadLocalMedia = async (page, name, mimeType) => {
  await page.evaluate(() => {
    document.getElementById('hyperplayer').src = 'blob:http://localhost/fake-local-media';
    if (!document.getElementById('__test_media_input')) {
      const el = document.createElement('input');
      el.type = 'file';
      el.id = '__test_media_input';
      document.body.appendChild(el);
    }
  });
  await page.setInputFiles('#__test_media_input', {
    name, mimeType, buffer: Buffer.from([0, 0, 0, 0]),
  });
};

const openExportModalValue = (page) => page.evaluate(() => {
  const modal = document.getElementById('interactive-export-modal');
  modal.checked = false;                       // ensure the change fires on (re)open
  modal.checked = true;
  modal.dispatchEvent(new Event('change'));
  return document.getElementById('interactive-media-filename').value;
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('pre-fills the export modal with a locally-loaded media filename', async ({ page }) => {
  await loadLocalMedia(page, 'my-clip.mp4', 'video/mp4');
  expect(await openExportModalValue(page)).toBe('my-clip.mp4');
});

test('the field refreshes to the current media on open, dropping a stale/typed value', async ({ page }) => {
  await loadLocalMedia(page, 'first-take.mp4', 'video/mp4');
  // user types something bogus into the field (the "test" footgun)
  await page.evaluate(() => { document.getElementById('interactive-media-filename').value = 'test'; });
  // loading a different clip then re-opening must show the NEW clip's name, not "test"
  await loadLocalMedia(page, 'second-take.webm', 'video/webm');
  expect(await openExportModalValue(page)).toBe('second-take.webm');
});

test('non-media (import) file inputs do not change the media reference', async ({ page }) => {
  await loadLocalMedia(page, 'interview.mp3', 'audio/mpeg');
  // selecting a JSON/SRT/VTT import file must NOT overwrite the media reference
  await page.setInputFiles('#__test_media_input', {
    name: 'transcript.json', mimeType: 'application/json', buffer: Buffer.from('{}'),
  });
  expect(await openExportModalValue(page)).toBe('interview.mp3');
});

test('a plain remote URL is linked directly and replaces a stale previous source', async ({ page }) => {
  await page.evaluate(async () => {
    const v = document.getElementById('hyperplayer');
    v.src = 'https://lab.hyperaud.io/audio/HLE_Intro_3.mp3';   // previous media
    await window.attachMediaPlayback(v, 'https://example.com/new/clip.mp4', false);
  });
  // the player src is the new URL, and the export references it
  expect(await page.evaluate(() => document.getElementById('hyperplayer').src))
    .toBe('https://example.com/new/clip.mp4');
  expect(await openExportModalValue(page)).toBe('https://example.com/new/clip.mp4');
});

test('an HLS source: player src becomes a blob but the export references the original URL', async ({ page }) => {
  const HLS = 'https://stream.place/xrpc/place.stream.playback.getVideoPlaylist?uri=at%3A%2F%2Fexample';
  await page.evaluate(async (hls) => {
    const v = document.getElementById('hyperplayer');
    v.src = 'https://lab.hyperaud.io/audio/HLE_Intro_3.mp3';   // stale previous media
    await window.attachMediaPlayback(v, hls, true);            // HLS → hls.js MediaSource
  }, HLS);
  // player src is now an opaque blob: (the previous mp3 is gone), and the export
  // links the real HLS URL rather than the blob or the stale mp3
  expect(await page.evaluate(() => document.getElementById('hyperplayer').src.startsWith('blob:'))).toBe(true);
  expect(await openExportModalValue(page)).toBe(HLS);
});

test('a fresh remote URL wins over a stale stamped local reference', async ({ page }) => {
  await page.evaluate(() => {
    const v = document.getElementById('hyperplayer');
    v.dataset.mediaRef = 'old-local.mp4';                      // left over from a prior local file
    v.src = 'https://example.com/fresh/remote.mp3';            // a cloud engine set a new URL
  });
  expect(await openExportModalValue(page)).toBe('https://example.com/fresh/remote.mp3');
});

test('the exported page includes the missing-media fallback and the typed reference', async ({ page }) => {
  await loadLocalMedia(page, 'clip.mp4', 'video/mp4');
  await openExportModalValue(page);
  // the template fetch resolves asynchronously after load — retry until the
  // download is built from the real template
  let text = '';
  for (let i = 0; i < 10 && !text.includes('<video'); i++) {
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(() => {
      const m = document.getElementById('interactive-export-modal');
      m.checked = true; m.dispatchEvent(new Event('change'));
    });
    await page.click('#interactive-export-download');
    const download = await downloadPromise;
    text = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
    if (!text.includes('<video')) await page.waitForTimeout(300);
  }
  expect(text).toMatch(/<video[^>]*src="clip\.mp4"/);
  // a page moved away from its media explains itself instead of a dead player
  expect(text).toContain('media-missing-note');
  expect(text).toContain('same folder as the media file');
  // attribution footer links back to the editor
  expect(text).toMatch(/<a href="https:\/\/hyperaudio\.github\.io\/hyperaudio-lite-editor\/"[^>]*>Made with Hyperaudio<\/a>/);
});

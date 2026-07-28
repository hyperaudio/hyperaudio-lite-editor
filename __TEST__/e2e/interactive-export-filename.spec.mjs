// Interactive-transcript export: pre-fill the media reference from the real
// filename of a locally-loaded file, and clear a stale value when new media is
// loaded. A local file is a blob: URL with no usable path, so previously the
// export modal's "Media file or URL" field started empty and whatever the user
// last typed (famously "test") could linger and be exported into src="…".
import { test, expect } from '@playwright/test';

// Simulate a local media load: a blob: player src (so the URL branch of
// guessMediaSrc doesn't win) plus a media file selected on a throwaway input,
// which the central capture listener reads for its name.
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

test('loading new media clears a stale filename so it cannot be exported by mistake', async ({ page }) => {
  await loadLocalMedia(page, 'first-take.mp4', 'video/mp4');
  // user types something bogus into the field (the "test" footgun)
  await page.evaluate(() => { document.getElementById('interactive-media-filename').value = 'test'; });
  // loading a different clip must drop that stale value…
  await loadLocalMedia(page, 'second-take.webm', 'video/webm');
  expect(await page.evaluate(() => document.getElementById('interactive-media-filename').value)).toBe('');
  // …and (re)opening offers the new clip's real name, not "test"
  expect(await openExportModalValue(page)).toBe('second-take.webm');
});

test('non-media (import) file inputs do not overwrite the export filename', async ({ page }) => {
  await loadLocalMedia(page, 'interview.mp3', 'audio/mpeg');
  await page.evaluate(() => { document.getElementById('interactive-media-filename').value = 'interview.mp3'; });
  // selecting a JSON/SRT/VTT import file must NOT clear or change the media name
  await page.setInputFiles('#__test_media_input', {
    name: 'transcript.json', mimeType: 'application/json', buffer: Buffer.from('{}'),
  });
  expect(await page.evaluate(() => document.getElementById('interactive-media-filename').value)).toBe('interview.mp3');
});

// #740 — media the browser cannot play. Safari refuses an avc3 MP4: the
// transcript loads, play() rejects, the duration stays NaN, and nothing said
// why, while Export media offered to save "NaNs". Now a line under the
// picture says so, a rejected play() is caught and reported rather than left
// unhandled, and the export dialog offers nothing while the media has no
// length. Chromium stands in for Safari with a source that is not media at
// all, which fails the same way.
import { test, expect } from '@playwright/test';

const BAD_URL = 'https://media.example.com/talks/broadcast.mp4';
const DEAD_URL = 'https://gone.example.com/talks/lost.mp4';

const setSource = (page, url) => page.evaluate((url) => {
  const player = document.getElementById('hyperplayer');
  player.src = url;
  player.load();
}, url);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('a source the browser cannot play says so under the player, and play() is caught', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // reachable, and not a video
  await page.route(BAD_URL, (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: 'this is not a video' }));
  await setSource(page, BAD_URL);
  const notice = page.locator('#media-unplayable');
  await expect(notice).toContainText('can’t play this media’s format');
  await expect(notice).toContainText('transcript still works');
  await page.evaluate(() => window.togglePlay());
  await page.waitForTimeout(300);
  expect(errors.filter((e) => /NotSupportedError|not supported/i.test(e))).toEqual([]);
  await expect(notice).toHaveCount(1);
});

test('a link that cannot be reached says that instead', async ({ page }) => {
  await page.route(DEAD_URL, (route) => route.abort());
  await setSource(page, DEAD_URL);
  const notice = page.locator('#media-unplayable');
  await expect(notice).toContainText('could not be loaded from its link');
  await expect(notice).not.toContainText('format');
});

test('the line goes when the player loads something else', async ({ page }) => {
  await page.route(BAD_URL, (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: 'this is not a video' }));
  await setSource(page, BAD_URL);
  await expect(page.locator('#media-unplayable')).toHaveCount(1);
  await setSource(page, '/__TEST__/fixtures/video-640x360.mp4');
  await expect(page.locator('#media-unplayable')).toHaveCount(0);
  // and nothing to say about a source that plays
  await page.evaluate(() => window.togglePlay());
  await page.waitForTimeout(500);
  await expect(page.locator('#media-unplayable')).toHaveCount(0);
});

test('Export media offers nothing while the media has no length, and shows no NaN', async ({ page }) => {
  await page.route(BAD_URL, (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: 'this is not a video' }));
  await setSource(page, BAD_URL);
  await expect(page.locator('#media-unplayable')).toHaveCount(1);
  // a strikeout, so the edited summary would have had a saving to show
  await page.evaluate(() => {
    const w = document.querySelector('#hypertranscript span[data-m]');
    w.style.textDecoration = 'line-through';
    w.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => {
    const t = document.getElementById('export-modal');
    t.checked = true;
    t.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#export-status')).toContainText('has not loaded', { timeout: 15000 });
  await expect(page.locator('#export-edit-summary')).not.toContainText('NaN');
  await expect(page.locator('#export-edit-summary')).toContainText('length unknown');
  await expect(page.locator('#export-start')).toHaveClass(/btn-disabled/);
  expect(await page.locator('#export-source-edited').isDisabled()).toBe(true);
});

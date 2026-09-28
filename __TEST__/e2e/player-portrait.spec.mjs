// A portrait video shows whole in the desktop player (#690). The frame is
// capped at 480px and clipped what overflowed, so a 9:16 video at the card's
// width lost its bottom quarter — where portrait captions sit.
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 900 } });

test('a portrait video fits the desktop player instead of being cut off', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(() => { document.getElementById('hyperplayer').src = '/__TEST__/fixtures/video-360x640.mp4'; });
  await page.waitForFunction(() => document.getElementById('hyperplayer').videoHeight === 640);
  const box = await page.evaluate(() => {
    const frame = document.getElementById('player-frame').getBoundingClientRect();
    const video = document.getElementById('hyperplayer').getBoundingClientRect();
    return { frameBottom: frame.bottom, frameHeight: frame.height, videoBottom: video.bottom, videoHeight: video.height };
  });
  expect(box.videoHeight).toBeLessThanOrEqual(480);
  expect(box.videoBottom).toBeLessThanOrEqual(box.frameBottom + 0.5);   // nothing clipped
});

test('a landscape video still fills the player width', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(() => { document.getElementById('hyperplayer').src = '/__TEST__/fixtures/video-640x360.mp4'; });
  await page.waitForFunction(() => document.getElementById('hyperplayer').videoWidth === 640);
  const [videoW, frameW] = await page.evaluate(() => [
    document.getElementById('hyperplayer').getBoundingClientRect().width,
    document.getElementById('player-frame').getBoundingClientRect().width,
  ]);
  expect(Math.abs(videoW - frameW)).toBeLessThan(1);
});

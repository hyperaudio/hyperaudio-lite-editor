// #617 — in the desktop two-pane layout the video's top sat 7px above the
// navbar buttons, and the controls row (PiP / audio-only) had 4px above it
// but 12px below. The audio-only (collapsed) offsets were hand-measured
// constants from before the navbar gained its 4px margin, so the row sat 4px
// high of the buttons it is meant to share a line with. Everything here is
// measured from the live layout, never from the constants.
import { test, expect } from '@playwright/test';

const box = (page, sel) => page.evaluate((s) => {
  const b = document.querySelector(s).getBoundingClientRect();
  return { top: b.top, bottom: b.bottom, mid: (b.top + b.bottom) / 2 };
}, sel);

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('the video top rides the navbar buttons, with equal air around the controls row (#617)', async ({ page }) => {
  const navBtn = await box(page, '#sidebar-toggle');
  const video = await box(page, '#hyperplayer');
  const controls = await box(page, '#player-controls');
  const recents = await box(page, '#recents-card');

  expect(Math.abs(video.top - navBtn.top)).toBeLessThanOrEqual(1);
  const above = controls.top - video.bottom;
  const below = recents.top - controls.bottom;
  expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
  expect(above).toBeGreaterThan(4);   // not merely equal because both are tiny
});

test('collapsed: the controls row is centred on the navbar buttons and Recents meets the card top (#617)', async ({ page }) => {
  await page.click('#audio-only-btn');
  // the collapse animates (0.5s), so poll for the SETTLED distance — the row
  // passes through the right line mid-slide, so a one-sided check would pass
  // early on any layout
  const navBtn = await box(page, '#sidebar-toggle');
  await expect.poll(async () => Math.abs((await box(page, '#player-controls')).mid - navBtn.mid), { timeout: 3000 })
    .toBeLessThanOrEqual(1);

  const card = await box(page, '.transcript-holder');
  await expect.poll(async () => Math.abs((await box(page, '#recents-card')).top - card.top), { timeout: 3000 })
    .toBeLessThanOrEqual(1);
});

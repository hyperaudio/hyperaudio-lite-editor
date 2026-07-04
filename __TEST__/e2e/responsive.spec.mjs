// The phone layout (#349/#375): pinned player, Recents drawer, and the
// audio-only collapse. Runs at 390×844.
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

const rect = (page, sel) => page.evaluate((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}, sel);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('single-column stack with no horizontal overflow', async ({ page }) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const navbar = await rect(page, '.main-panel');
  const player = await rect(page, '#player-pane');
  const transcript = await rect(page, '.transcript-holder');
  const playbar = await rect(page, '#playbar');
  expect(player.y).toBeGreaterThanOrEqual(navbar.h - 1);
  expect(transcript.y).toBeGreaterThanOrEqual(player.y + player.h - 2);
  expect(playbar.y).toBeGreaterThan(transcript.y);
});

test('Recents drawer slides in via the sidebar toggle and closes on backdrop', async ({ page }) => {
  expect((await rect(page, '#recents-pane')).x).toBeLessThan(0); // off-canvas
  await page.click('#sidebar-toggle');
  await page.waitForTimeout(350);
  expect((await rect(page, '#recents-pane')).x).toBeGreaterThanOrEqual(0);
  await page.mouse.click(375, 422); // exposed backdrop right of the 320px drawer
  await page.waitForTimeout(350);
  expect((await rect(page, '#recents-pane')).x).toBeLessThan(0);
});

test('audio-only collapses the pinned player to the controls strip', async ({ page }) => {
  const before = (await rect(page, '.transcript-holder')).y;
  await page.click('#audio-only-btn');
  await page.waitForTimeout(400);
  expect((await rect(page, '#player-pane')).h).toBeLessThan(60);
  expect((await rect(page, '.transcript-holder')).y).toBeLessThan(before);
  expect(await page.evaluate(() => document.body.classList.contains('video-collapsed'))).toBe(true);
});

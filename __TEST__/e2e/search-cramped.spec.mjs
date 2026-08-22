// #592: the search input bottoms out at 48px — its own padding plus the clear
// button — and then stays there, a visible focusable stub with ~2px of room
// for text. It happens in two bands, either side of the 948px layout change,
// so what decides it is the room the navbar has, not the viewport width.
import { test, expect } from '@playwright/test';

const searchVisible = (page) => page.evaluate(() => {
  const centre = document.querySelector('.navbar-center');
  return getComputedStyle(centre).display !== 'none';
});

// room for text inside the box: its width less its own padding
const textRoom = (page) => page.evaluate(() => {
  const box = document.getElementById('search-box');
  const cs = getComputedStyle(box);
  return box.getBoundingClientRect().width
    - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('the search is gone in BOTH cramped bands, not just the reported one (#592)', async ({ page }) => {
  for (const width of [1000, 960, 620, 600]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(200);
    expect(await searchVisible(page), `search should be hidden at ${width}px`).toBe(false);
  }
});

test('the search stays where it is usable (#592)', async ({ page }) => {
  for (const width of [1400, 1200, 1120, 900, 800]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(200);
    expect(await searchVisible(page), `search should be visible at ${width}px`).toBe(true);
    // and visible means typable, not a stub
    expect(await textRoom(page), `usable text room at ${width}px`).toBeGreaterThan(80);
  }
});

test('an active search is cleared on the way out, leaving no orphan highlights (#592)', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.waitForTimeout(200);
  // pressSequentially, not fill: the vendored search runs off keyup
  await page.locator('#search-box').pressSequentially('the', { delay: 40 });
  await page.waitForTimeout(500);
  expect(await page.locator('#hypertranscript mark.search-mark').count())
    .toBeGreaterThan(0);

  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(400);

  expect(await searchVisible(page)).toBe(false);
  // the query went with it — no highlighted matches stranded with no control
  expect(await page.locator('#hypertranscript mark.search-mark').count())
    .toBe(0);
  expect(await page.inputValue('#search-box')).toBe('');
});

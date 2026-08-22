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

test('the cut-off sits where it was chosen, in both bands (#592)', async ({ page }) => {
  // 1070px is the deliberate boundary: an 83px box with ~37px for text. One
  // notch narrower and it goes, rather than creeping toward the 48px floor.
  for (const [width, shown] of [[1070, true], [1060, false], [670, true], [660, false]]) {
    await page.setViewportSize({ width, height: 800 });
    // poll rather than sleep: the navbar's width animates, so a fixed wait
    // reads a size that is still on its way somewhere
    await expect.poll(() => searchVisible(page), { message: `search at ${width}px` })
      .toBe(shown);
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

test('hiding the search leaves Save/Export/New still right-aligned (#594)', async ({ page }) => {
  // .navbar-center was the only flex: 1 1 auto item, so hiding it took the
  // growing with it and left both fixed sides bunched at the left — the
  // right-hand buttons trailing a gap where the search used to be.
  for (const width of [1400, 1050, 1000, 960, 900, 620, 600]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    const gap = await page.evaluate(() => {
      const nav = document.querySelector('.main-panel .navbar');
      const end = document.querySelector('.navbar-end');
      return nav.getBoundingClientRect().right - end.getBoundingClientRect().right;
    });
    // the navbar's own right padding, and nothing more, whether or not the
    // search is showing at this width
    expect(gap, `right-hand gap at ${width}px`).toBeLessThan(12);
  }
});

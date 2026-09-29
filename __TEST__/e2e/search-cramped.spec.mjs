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

// What the navbar has left for the search once its two fixed sides are in:
// the number responsive.js decides on.
const searchRoom = (page) => page.evaluate(() => {
  const w = (sel) => document.querySelector(sel).getBoundingClientRect().width;
  return w('.main-panel .navbar') - w('.navbar-start') - w('.navbar-end');
});

test('the cut-off sits where it was chosen, in both bands (#592)', async ({ page }) => {
  // The rule is 128px of room: with it the search shows, without it it goes,
  // rather than creeping toward the 48px floor. On the machine it was chosen
  // on that lands at 1070px and 670px wide; the width it lands at elsewhere
  // depends on the fonts the toolbar is drawn in (#706), so this walks each
  // band and holds every width to the rule — and each band to ONE cut-off.
  for (const band of [[1120, 1000], [720, 600]]) {
    const seen = [];
    for (let width = band[0]; width >= band[1]; width -= 10) {
      await page.setViewportSize({ width, height: 800 });
      // poll rather than sleep: the navbar's width animates, so a fixed wait
      // reads a size that is still on its way somewhere. Settled means the
      // room has stopped changing AND the search agrees with it.
      await expect.poll(async () => {
        const before = await searchRoom(page);
        await page.waitForTimeout(150);
        const room = await searchRoom(page);
        return room === before && (await searchVisible(page)) === (room >= 128);
      }, { message: `search at ${width}px follows the room it has` }).toBe(true);
      seen.push(await searchVisible(page));
    }
    expect(seen[0], `search visible at ${band[0]}px`).toBe(true);
    expect(seen[seen.length - 1], `search hidden at ${band[1]}px`).toBe(false);
    // once gone it stays gone: a single cut-off, no flicker back
    expect(seen.indexOf(false), 'one cut-off in the band').toBe(seen.lastIndexOf(true) + 1);
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

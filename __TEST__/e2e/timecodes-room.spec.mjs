// #747 — with Recents open, a window just wide enough to keep it (949px to
// about 1040px) left the transcript's margin narrower than the timecodes,
// which went off the card's left edge. The transcript now gives up only what
// they lack, from the left, and is untouched where there is room.
import { test, expect } from '@playwright/test';

const measure = (page) => page.evaluate(() => {
  const h = document.querySelector('.transcript-holder').getBoundingClientRect();
  const t = document.getElementById('hypertranscript').getBoundingClientRect();
  const labels = [...document.querySelectorAll('.para-timecode')].map((el) => el.getBoundingClientRect());
  return { holderLeft: h.left, left: t.left, right: t.right, width: t.width, labelLeft: Math.min(...labels.map((r) => r.left)), labelRight: Math.max(...labels.map((r) => r.right)) };
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

for (const width of [1040, 1000, 950]) {
  test(`at ${width}px the timecodes stay on the card, and the text keeps its right edge`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const before = await measure(page);
    await page.evaluate(() => { const c = document.getElementById('show-timecodes'); c.checked = true; c.dispatchEvent(new Event('change')); });
    await expect.poll(() => page.locator('.para-timecode').count()).toBeGreaterThan(0);
    await expect.poll(async () => (await measure(page)).labelLeft).toBeGreaterThanOrEqual(before.holderLeft);
    const after = await measure(page);
    expect(after.labelRight).toBeLessThan(after.left);                 // still beside the text, not over it
    expect(Math.abs(after.right - before.right)).toBeLessThanOrEqual(1);
    expect(before.width - after.width).toBeLessThanOrEqual(60);        // only what they lack
    // off again, the transcript is as it was
    await page.evaluate(() => { const c = document.getElementById('show-timecodes'); c.checked = false; c.dispatchEvent(new Event('change')); });
    await expect.poll(async () => (await measure(page)).width).toBe(before.width);
  });
}

test('where there is room the transcript does not move', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const before = await measure(page);
  await page.evaluate(() => { const c = document.getElementById('show-timecodes'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await expect.poll(() => page.locator('.para-timecode').count()).toBeGreaterThan(0);
  const after = await measure(page);
  expect([after.left, after.width]).toEqual([before.left, before.width]);
});

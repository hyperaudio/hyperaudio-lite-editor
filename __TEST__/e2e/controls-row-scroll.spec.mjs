// #746 — on the narrow layout the controls row under the pinned video scrolled
// up and down: overflow-x: auto made overflow-y auto too, and the buttons'
// hidden tooltips, placed below the row, gave it something to scroll to.
import { test, expect } from '@playwright/test';

for (const width of [900, 390]) {
  test(`at ${width}px the controls row does not scroll up and down`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/index.html');
    await page.waitForSelector('#hypertranscript [data-m]');
    const row = page.locator('#player-controls');
    await row.hover();
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(300);
    expect(await row.evaluate((el) => el.scrollTop)).toBe(0);
    // the buttons stay where they were, under the video
    const [frame, pip] = await page.evaluate(() => ['player-frame', 'pip-btn']
      .map((id) => document.getElementById(id).getBoundingClientRect()));
    expect(pip.top).toBeGreaterThanOrEqual(frame.bottom);
  });
}

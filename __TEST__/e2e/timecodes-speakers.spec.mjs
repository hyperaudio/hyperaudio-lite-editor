// #817 — turning speaker labels off or on changes how many lines a paragraph
// takes, and the timecodes stayed where they were, drifting below their
// paragraphs further down the transcript. They now follow the toggle.
import { test, expect } from '@playwright/test';

// how far each timecode's top is from its paragraph's top, in pixels
const offsets = (page) => page.evaluate(() => {
  const paragraphs = [...document.querySelectorAll('#hypertranscript p')].filter((p) => p.querySelector('[data-m]'));
  const labels = [...document.querySelectorAll('.para-timecode')];
  return paragraphs.map((p, i) => Math.round(labels[i].getBoundingClientRect().top - p.getBoundingClientRect().top));
});
const toggle = (page, id, on) => page.evaluate(({ id, on }) => {
  const c = document.getElementById(id);
  c.checked = on;
  c.dispatchEvent(new Event('change', { bubbles: true }));
}, { id, on });

test('timecodes stay level with their paragraphs when speaker labels are hidden and shown (#817)', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // a label long enough to push every paragraph onto an extra line
  await page.evaluate(() => {
    document.querySelectorAll('#hypertranscript p').forEach((p) => {
      const first = p.querySelector('[data-m]');
      if (!first) return;
      const label = document.createElement('span');
      label.className = 'speaker';
      label.dataset.m = first.dataset.m;
      label.dataset.d = '0';
      label.textContent = '[' + 'A speaker with a very long name indeed '.repeat(3) + '] ';
      p.insertBefore(label, p.firstChild);
    });
  });
  await toggle(page, 'show-speakers', true);
  await toggle(page, 'show-timecodes', true);
  await expect.poll(() => page.locator('.para-timecode').count()).toBeGreaterThan(1);
  const level = await offsets(page);
  const heightWith = await page.evaluate(() => [...document.querySelectorAll('#hypertranscript p')].reduce((sum, p) => sum + p.getBoundingClientRect().height, 0));

  await toggle(page, 'show-speakers', false);
  // the labels really did take lines, or the test proves nothing
  expect(await page.evaluate(() => [...document.querySelectorAll('#hypertranscript p')].reduce((sum, p) => sum + p.getBoundingClientRect().height, 0))).toBeLessThan(heightWith);
  await expect.poll(() => offsets(page)).toEqual(level);

  await toggle(page, 'show-speakers', true);
  await expect.poll(() => offsets(page)).toEqual(level);
});

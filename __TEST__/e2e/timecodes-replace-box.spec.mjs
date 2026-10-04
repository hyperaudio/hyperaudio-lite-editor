// Paragraph timecodes sit in the transcript's left margin, placed from each
// paragraph's position. Opening the replace box eases the transcript's top
// padding down, which moves every paragraph without resizing the holder or
// changing its content — so nothing told the labels, and they stayed behind.
import { test, expect } from '@playwright/test';

const offsets = (page) => page.evaluate(() => {
  const paragraphs = [...document.querySelectorAll('#hypertranscript p')]
    .filter((p) => p.querySelector('span[data-m]:not(.speaker)'));
  const labels = [...document.querySelectorAll('.transcript-holder > .para-timecode')];
  return {
    count: labels.length,
    paragraphTop: Math.round(paragraphs[0].getBoundingClientRect().top),
    worst: Math.max(...labels.map((label, i) =>
      Math.abs(label.getBoundingClientRect().top - paragraphs[i].getBoundingClientRect().top))),
  };
});

test('timecodes move with the transcript when the replace box opens and closes', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(() => {
    const box = document.getElementById('show-timecodes');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
  });
  const before = await offsets(page);
  expect(before.count).toBeGreaterThan(0);
  expect(before.worst).toBeLessThan(1.5);

  await page.click('#find-replace-toggle');
  // the transcript has moved down, and the labels with it
  await expect.poll(async () => (await offsets(page)).paragraphTop).toBeGreaterThan(before.paragraphTop + 20);
  await expect.poll(async () => (await offsets(page)).worst).toBeLessThan(1.5);
  await page.waitForTimeout(400); // past the easing: still together, not just crossing
  expect((await offsets(page)).worst).toBeLessThan(1.5);

  await page.click('#replace-close');
  await expect.poll(async () => (await offsets(page)).paragraphTop).toBe(before.paragraphTop);
  await page.waitForTimeout(400);
  expect((await offsets(page)).worst).toBeLessThan(1.5);
});

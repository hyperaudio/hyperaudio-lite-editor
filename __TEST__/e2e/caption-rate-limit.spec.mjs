// #641 — the rate had nothing to judge it against. A limit per measure in
// Settings flags a caption that goes over it: colour, weight and words, never
// colour alone, and advisory only.
import { test, expect } from '@playwright/test';

const openCaptions = async (page) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
};

const flagged = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#captions-display .caption .caption-rate')]
    .map((el) => ({ text: el.textContent, over: el.classList.contains('caption-rate-over'), title: el.getAttribute('title') })));

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('the defaults are the standards (#641)', async ({ page }) => {
  expect(await page.evaluate(() => [
    window.HyperaudioSettings.get('captionMaxCps'),
    window.HyperaudioSettings.get('captionMaxWpm'),
  ])).toEqual([17, 180]);
  expect(await page.evaluate(() => window.HyperaudioSettings.captionRateLimit()))
    .toEqual({ measure: 'cps', limit: 17 });
});

test('a caption over the limit is flagged, one under it is not (#641)', async ({ page }) => {
  await openCaptions(page);
  const rows = await flagged(page);
  const over = rows.filter((r) => r.over);
  const under = rows.filter((r) => !r.over && r.text !== '');
  expect(over.length).toBeGreaterThan(0);          // the intro's own captions run fast
  expect(under.length).toBeGreaterThan(0);         // but not all of them

  over.forEach((r) => {
    expect(Number(r.text.split(' ')[0])).toBeGreaterThan(17);
    expect(r.title).toContain('over the 17 cps limit');   // said in words, not only in colour
  });
  under.forEach((r) => expect(Number(r.text.split(' ')[0])).toBeLessThanOrEqual(17));
});

test('raising the limit clears the flags, lowering it sets them (#641)', async ({ page }) => {
  await openCaptions(page);
  const before = (await flagged(page)).filter((r) => r.over).length;
  expect(before).toBeGreaterThan(0);

  await page.evaluate(() => {
    window.HyperaudioSettings.set('captionMaxCps', 60);
    window.updateCaptionRates();
  });
  expect((await flagged(page)).filter((r) => r.over).length).toBe(0);

  await page.evaluate(() => {
    window.HyperaudioSettings.set('captionMaxCps', 1);
    window.updateCaptionRates();
  });
  const all = await flagged(page);
  expect(all.filter((r) => r.over).length).toBe(all.filter((r) => r.text !== '').length);
});

test('each measure is judged by its own limit (#641)', async ({ page }) => {
  await openCaptions(page);
  await page.evaluate(() => {
    window.HyperaudioSettings.set('captionRate', 'wpm');
    window.HyperaudioSettings.set('captionMaxWpm', 400);   // nothing can exceed this
    window.updateCaptionRates();
  });
  expect((await flagged(page)).filter((r) => r.over).length).toBe(0);

  await page.evaluate(() => {
    window.HyperaudioSettings.set('captionMaxWpm', 120);
    window.updateCaptionRates();
  });
  const rows = await flagged(page);
  expect(rows.filter((r) => r.over).length).toBeGreaterThan(0);
  rows.filter((r) => r.over).forEach((r) => expect(r.title).toContain('over the 120 wpm limit'));
});

test('editing a caption re-judges it (#641)', async ({ page }) => {
  await openCaptions(page);
  const first = '#captions-display .caption:first-child';
  // make it impossibly fast, then give it room
  await page.fill(`${first} .line1`, 'A very long line of text indeed, far too much to read');
  await expect.poll(async () => (await flagged(page))[0].over).toBe(true);
  await page.fill(`${first} .end`, '00:01:00.000');
  await expect.poll(async () => (await flagged(page))[0].over).toBe(false);
});

test('with the rate off there is nothing to flag (#641)', async ({ page }) => {
  await openCaptions(page);
  await page.evaluate(() => {
    window.HyperaudioSettings.set('captionRate', 'none');
    window.updateCaptionRates();
  });
  expect(await page.evaluate(() => window.HyperaudioSettings.captionRateLimit())).toBeNull();
  expect((await flagged(page)).every((r) => r.text === '' && !r.over)).toBe(true);
});

test('a limit of zero keeps the number and drops the judgement (#641)', async ({ page }) => {
  await openCaptions(page);
  await page.evaluate(() => {
    window.HyperaudioSettings.set('captionMaxCps', 0);
    window.updateCaptionRates();
  });
  const rows = await flagged(page);
  expect(rows.filter((r) => r.text !== '').length).toBeGreaterThan(0);
  expect(rows.some((r) => r.over)).toBe(false);
});

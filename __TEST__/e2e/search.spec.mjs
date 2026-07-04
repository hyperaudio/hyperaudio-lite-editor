// Search highlighting, including the punctuated-match fix ported from
// hyperaudio-lite 2.6.2 (#260 upstream): matching compares punctuation-stripped
// text, and the highlight must cover the whole raw word.
import { test, expect } from '@playwright/test';

const search = (page, query) => page.evaluate((q) => {
  const sb = document.querySelector('#search-box');
  sb.value = q;
  sb.dispatchEvent(new KeyboardEvent('keyup'));
  return [...document.querySelectorAll('#hypertranscript mark.search-mark')].map((m) => m.textContent);
}, query);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('plain search marks every occurrence', async ({ page }) => {
  const marks = await search(page, 'captions');
  expect(marks.length).toBeGreaterThanOrEqual(2);
  marks.forEach((m) => expect(m.toLowerCase()).toBe('captions'));
});

test('matches with internal punctuation highlight whole', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelector('#hypertranscript p').insertAdjacentHTML(
      'beforeend', '<span data-m="57000" data-d="300">SPEAKER-2 </span>');
  });
  expect(await search(page, 'speaker2')).toEqual(['SPEAKER-2']);
  expect(await search(page, 'speaker-2')).toEqual(['SPEAKER-2']);
  expect((await search(page, "we'll")).length).toBeGreaterThan(0);
});

test('clearing the query clears the marks', async ({ page }) => {
  await search(page, 'captions');
  const after = await search(page, '');
  expect(after).toEqual([]);
});

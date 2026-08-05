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

// #495 — css/hyperaudio-lite-player.css is byte-identical to upstream again, with
// the editor's deviations moved into css/hyperaudio-lite-editor.css. Upstream
// paints .hyperaudio-transcript .search-mark PINK at specificity (0,2,0), so the
// editor's override has to outrank it; a bare `mark.search-mark` is only (0,1,1)
// and would lose, turning every hit pink. This guards that arithmetic, which is
// otherwise invisible until someone re-vendors the file.
test('the editor\'s search colours outrank the vendored player stylesheet (#495)', async ({ page }) => {
  await search(page, 'the');
  const colours = await page.evaluate(() => {
    const marks = [...document.querySelectorAll('#hypertranscript mark.search-mark')];
    if (marks.length === 0) return null;
    marks[0].classList.add('active');
    const active = getComputedStyle(marks[0]).backgroundColor;
    marks[0].classList.remove('active');
    return { hit: getComputedStyle(marks[0]).backgroundColor, active };
  });

  expect(colours).not.toBeNull();
  // upstream's pink is rgb(255, 192, 203) — losing the cascade would show it
  expect(colours.hit).not.toBe('rgb(255, 192, 203)');
  expect(colours.active).not.toBe('rgb(255, 192, 203)');
  // the active match stays visually distinct from an ordinary hit
  expect(colours.active).not.toBe(colours.hit);
  // and it is the intended amber, on specificity rather than source order
  expect(colours.active).toBe('rgb(246, 195, 68)');
});

test('unread words keep the accessibility contrast, not upstream\'s lighter grey (#495)', async ({ page }) => {
  const colour = await page.evaluate(() => {
    const el = document.querySelector('#hypertranscript span[data-m].unread');
    return el === null ? null : getComputedStyle(el).color;
  });
  // #666 from 5e37ad6 ("best practices and accessibility"), not upstream's #777
  if (colour !== null) expect(colour).toBe('rgb(102, 102, 102)');
});

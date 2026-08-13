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

// #557 — a phrase is ONE match. searchPhrase marks one span per query word,
// so "big pharma" used to report two matches per occurrence and Replace
// swapped a single word's mark: "big pharma" → "Big Pharma" was impossible.
const openReplace = async (page, query, replacement) => {
  await page.evaluate(({ q, r }) => {
    const sb = document.querySelector('#search-box');
    sb.value = q;
    sb.dispatchEvent(new KeyboardEvent('keyup'));
    document.getElementById('find-replace-toggle').click();
    document.getElementById('replace-box').value = r;
  }, { q: query, r: replacement });
};
const transcriptWords = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')]
    .map((s) => ({ text: s.textContent.trim(), m: s.getAttribute('data-m'), d: s.getAttribute('data-d') })));

const plantPhrase = (page) => page.evaluate(() => {
  const spans = document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)');
  spans[0].textContent = 'big ';
  spans[1].textContent = 'pharma ';
  spans[4].textContent = 'big ';
  spans[5].textContent = 'pharma ';
});

test('a phrase counts as one match, not one per word (#557)', async ({ page }) => {
  await plantPhrase(page);
  await openReplace(page, 'big pharma', 'Big Pharma');
  await expect(page.locator('#find-match-count')).toHaveText('1 / 2'); // two occurrences
});

test('replacing a phrase rewrites every word and keeps each span\'s timing (#557)', async ({ page }) => {
  await plantPhrase(page);
  const before = (await transcriptWords(page)).slice(0, 6);
  await openReplace(page, 'big pharma', 'Big Pharma');
  await page.click('#replace-one');
  const after = (await transcriptWords(page)).slice(0, 6);

  expect(after[0].text).toBe('Big');
  expect(after[1].text).toBe('Pharma');
  // the timings the words were spoken at are untouched
  expect(after[0].m).toBe(before[0].m);
  expect(after[0].d).toBe(before[0].d);
  expect(after[1].m).toBe(before[1].m);
  expect(after[1].d).toBe(before[1].d);
  // and the second occurrence is still there, awaiting its turn
  expect(after[4].text).toBe('big');
  expect(after[5].text).toBe('pharma');
});

test('Replace All rewrites every occurrence of a phrase (#557)', async ({ page }) => {
  await plantPhrase(page);
  await openReplace(page, 'big pharma', 'Big Pharma');
  await page.click('#replace-all');
  const after = (await transcriptWords(page)).slice(0, 6);
  expect([after[0].text, after[1].text]).toEqual(['Big', 'Pharma']);
  expect([after[4].text, after[5].text]).toEqual(['Big', 'Pharma']);
});

test('a shorter replacement drops the spans it empties (#557)', async ({ page }) => {
  await plantPhrase(page);
  const before = await transcriptWords(page);
  await openReplace(page, 'big pharma', 'BigPharma');
  await page.click('#replace-one');
  const after = await transcriptWords(page);
  expect(after[0].text).toBe('BigPharma');
  expect(after[0].m).toBe(before[0].m);      // first span keeps its timing
  expect(after.length).toBe(before.length - 1); // the emptied span is gone
});

test('a longer replacement keeps its surplus in the last span (#557)', async ({ page }) => {
  await plantPhrase(page);
  await openReplace(page, 'big pharma', 'the big pharmaceutical industry');
  await page.click('#replace-one');
  const after = (await transcriptWords(page)).slice(0, 2);
  expect(after[0].text).toBe('the');
  expect(after[1].text).toBe('big pharmaceutical industry');
});

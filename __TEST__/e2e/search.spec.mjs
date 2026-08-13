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

// #558 — a search you can clear. The ✕ appears only when there is something
// to clear, and Escape in the box does the same without closing the panel's
// world around it.
test('the ✕ clears the query, the marks and the count (#558)', async ({ page }) => {
  const clear = page.locator('#search-clear');
  await expect(clear).toBeHidden(); // nothing to clear yet

  await search(page, 'captions');
  await expect(clear).toBeVisible();
  expect(await page.locator('#hypertranscript mark.search-mark').count()).toBeGreaterThan(0);

  await clear.click();
  expect(await page.inputValue('#search-box')).toBe('');
  await expect(page.locator('#hypertranscript mark.search-mark')).toHaveCount(0);
  await expect(clear).toBeHidden();
});

test('Escape in the search box clears it (#558)', async ({ page }) => {
  await search(page, 'captions');
  await page.click('#find-replace-toggle');           // panel open
  await page.focus('#search-box');
  await page.keyboard.press('Escape');
  expect(await page.inputValue('#search-box')).toBe('');
  await expect(page.locator('#hypertranscript mark.search-mark')).toHaveCount(0);
  // the first Escape cleared rather than closed; a second one closes
  await expect(page.locator('#replace-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#replace-panel')).toBeHidden();
});

// #559 — correcting a match by hand must not cost you the panel or your
// place in the matches. The click that places the caret used to close the
// panel, and the re-search dumped you back at match 1.
test('a click into the transcript leaves the replace panel open (#559)', async ({ page }) => {
  await search(page, 'captions');
  await page.click('#find-replace-toggle');
  await expect(page.locator('#replace-panel')).toBeVisible();

  await page.click('#hypertranscript span[data-m]:not(.speaker)');
  await expect(page.locator('#replace-panel')).toBeVisible();

  // a click genuinely elsewhere still closes it (the Recents heading is
  // inert — the player is covered by its own play overlay)
  await page.click('#recents-title');
  await expect(page.locator('#replace-panel')).toBeHidden();
});

test('a hand correction keeps your place in the matches (#559)', async ({ page }) => {
  // four occurrences of a word, so there is a middle to hold
  await page.evaluate(() => {
    const spans = document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)');
    [0, 3, 6, 9].forEach((i) => { spans[i].textContent = 'widget '; });
  });
  await search(page, 'widget');
  await page.click('#find-replace-toggle');
  await expect(page.locator('#find-match-count')).toHaveText('1 / 4');

  await page.click('#find-next');
  await page.click('#find-next');
  await expect(page.locator('#find-match-count')).toHaveText('3 / 4');

  // hand-correct the THIRD occurrence's neighbour, as a user would
  await page.evaluate(() => {
    const spans = document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)');
    const target = spans[7];
    const range = document.createRange();
    range.setStart(target.firstChild, 1);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('hypertranscript').focus();
  });
  await page.keyboard.type('X');
  await page.waitForTimeout(1600); // the debounced re-search

  // still open, still four matches, and anchored at the one we were on —
  // not reset to 1 / 4
  await expect(page.locator('#replace-panel')).toBeVisible();
  await expect(page.locator('#find-match-count')).toHaveText('4 / 4');
});

// The group size must follow the VENDORED search's needles, not raw
// whitespace tokens: it strips punctuation per word and drops any that
// empties. "big , pharma" is two needles — grouping by three misaligned
// every match after the first.
test('a query with a punctuation-only token still groups correctly (#557)', async ({ page }) => {
  await page.evaluate(() => {
    const spans = document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)');
    spans[0].textContent = 'big '; spans[1].textContent = 'pharma ';
    spans[4].textContent = 'big '; spans[5].textContent = 'pharma ';
  });
  await page.evaluate(() => {
    const sb = document.querySelector('#search-box');
    sb.value = 'big , pharma';           // three tokens, two needles
    sb.dispatchEvent(new KeyboardEvent('keyup'));
    document.getElementById('find-replace-toggle').click();
    document.getElementById('replace-box').value = 'Big Pharma';
  });
  await expect(page.locator('#find-match-count')).toHaveText('1 / 2');
  await page.click('#replace-all');
  const words = await page.evaluate(() =>
    [...document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')]
      .slice(0, 6).map((s) => s.textContent.trim()));
  expect([words[0], words[1]]).toEqual(['Big', 'Pharma']);
  expect([words[4], words[5]]).toEqual(['Big', 'Pharma']);
});

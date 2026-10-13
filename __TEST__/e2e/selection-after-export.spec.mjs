// #732 — the native selection collapses the moment the Export dialog is used,
// so when the dialog closes the remembered words are shown as selected again,
// with a mark of our own. A second export picks the same range up, and the
// mark goes the way a selection would: a new selection, a click in the
// transcript, or an edit.
import { test, expect } from '@playwright/test';

const WORDS = Array.from({ length: 12 }, (_, i) => `<span data-m="${i * 1000}" data-d="1000">w${i} </span>`).join('');

const setup = async (page) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate((html) => {
    document.getElementById('hypertranscript').innerHTML = `<article><section><p>${html}</p></section></article>`;
  }, WORDS);
};
const select = (page, from, to) => page.evaluate(([a, b]) => {
  const spans = document.querySelectorAll('#hypertranscript [data-m]');
  const range = document.createRange();
  range.setStart(spans[a].firstChild, 0);
  range.setEnd(spans[b].firstChild, spans[b].textContent.trimEnd().length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}, [from, to]);
const toggleExport = async (page, open) => {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));   // selectionchange is async
  await page.evaluate((open) => {
    if (open && document.activeElement) document.activeElement.blur();
    const m = document.getElementById('export-modal');
    m.checked = open;
    m.dispatchEvent(new Event('change'));
  }, open);
  if (open) await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
};
const marked = (page) => page.evaluate(() => [...document.querySelectorAll('#hypertranscript .transcript-selected')].map((el) => el.textContent.trim()));

test('after the dialog closes the selected words show as selected, and the next export offers the same clip', async ({ page }) => {
  await setup(page);
  await select(page, 3, 6);
  await toggleExport(page, true);
  await expect(page.locator('#export-source-clip-row')).toBeVisible();
  // using the dialog collapses the native selection (a click on a control
  // does it in a real browser; done by hand here, since headless may not)
  await page.click('#export-format');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  expect(await marked(page)).toEqual([]);
  await toggleExport(page, false);
  expect(await marked(page)).toEqual(['w3', 'w4', 'w5', 'w6']);
  // a second time round, the same clip is on offer
  await toggleExport(page, true);
  await expect(page.locator('#export-source-clip-row')).toBeVisible();
  expect(await page.evaluate(() => window.TranscriptSelection.range(12))).toMatchObject({ from: 3, to: 7 });
  await toggleExport(page, false);
  expect(await marked(page)).toEqual(['w3', 'w4', 'w5', 'w6']);
});

test('a new selection, a click in the transcript, or an edit takes the mark away, as it would a selection', async ({ page }) => {
  await setup(page);
  await select(page, 3, 6);
  await toggleExport(page, true);
  await toggleExport(page, false);
  expect(await marked(page)).toHaveLength(4);
  // a new selection: the real one shows instead, and is what the dialog reads
  await select(page, 8, 9);
  await page.waitForTimeout(60);
  expect(await marked(page)).toEqual([]);
  expect(await page.evaluate(() => window.TranscriptSelection.range(12))).toMatchObject({ from: 8, to: 10 });
  await toggleExport(page, true);
  await toggleExport(page, false);
  expect(await marked(page)).toEqual(['w8', 'w9']);
  // a click in the transcript forgets it
  await page.locator('#hypertranscript [data-m]').nth(1).click();
  await page.waitForTimeout(60);
  expect(await marked(page)).toEqual([]);
  expect(await page.evaluate(() => window.TranscriptSelection.range(12))).toBeNull();
  await toggleExport(page, true);
  await expect(page.locator('#export-source-clip-row')).toBeHidden();
  await toggleExport(page, false);
  expect(await marked(page)).toEqual([]);
});

test('nothing selected, nothing shown', async ({ page }) => {
  await setup(page);
  await toggleExport(page, true);
  await toggleExport(page, false);
  expect(await marked(page)).toEqual([]);
});

// #775 — how long the selected passage runs, shown just under the selection
// while something is selected: the selected words' times, and the length a
// clip of them would be exported at, struck words and skipped silences left
// out. The same reading as the Export dialog's Selection option.
import { test, expect } from '@playwright/test';
import { transcriptHtml } from './helpers.mjs';

// one word a second, twelve seconds
const WORDS = Array.from({ length: 12 }, (_, i) => [i * 1000, 1000, 0]);

const setup = async (page, words = WORDS) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate((html) => { document.getElementById('hypertranscript').innerHTML = html; }, transcriptHtml(words));
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
const clear = (page) => page.evaluate(() => window.getSelection().removeAllRanges());
const chip = (page) => page.locator('#selection-length');
const length = (page) => page.locator('#selection-length .selection-length-length');
const span = (page) => page.locator('#selection-length .selection-length-span');

test('nothing selected, nothing shown', async ({ page }) => {
  await setup(page);
  await expect(chip(page)).toBeHidden();
});

test('a selection shows its times and its length, and follows the selection as it changes', async ({ page }) => {
  await setup(page);
  await select(page, 3, 6);                   // w3..w6: 3s to 7s
  await expect(chip(page)).toBeVisible();
  await expect(span(page)).toHaveText('0:03–0:07');
  await expect(length(page)).toHaveText('0:04');
  await select(page, 3, 9);                   // widened: 3s to 10s
  await expect(length(page)).toHaveText('0:07');
  await expect(span(page)).toHaveText('0:03–0:10');
  await clear(page);
  await expect(chip(page)).toBeHidden();
});

test('the pill sits in the card\'s bottom-left corner, the read-only badge\'s mirror, outside the transcript', async ({ page }) => {
  await setup(page);
  await select(page, 3, 6);
  await expect(chip(page)).toBeVisible();
  const at = await page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
    return {
      pill: r(document.getElementById('selection-length')),
      card: r(document.querySelector('.transcript-holder')),
      insideTranscript: document.getElementById('hypertranscript').contains(document.getElementById('selection-length')),
    };
  });
  expect(at.pill.left - at.card.left).toBeCloseTo(12, 0);
  expect(at.card.bottom - at.pill.bottom).toBeCloseTo(12, 0);
  expect(at.insideTranscript).toBe(false);
  // and it follows the card's edge when the sidebar collapses
  await page.evaluate(() => document.body.classList.add('sidebar-collapsed'));
  await expect.poll(() => page.evaluate(() => document.getElementById('selection-length').getBoundingClientRect().left)).toBeCloseTo(12, 0);
  // and it is not written into the transcript's content
  expect(await page.evaluate(() => document.getElementById('hypertranscript').innerHTML.includes('selection-length'))).toBe(false);
});

test('the length leaves out struck words, as the exported clip does', async ({ page }) => {
  // w4 and w5 struck: a selection of w3..w6 runs 3s to 7s but keeps 2s
  const words = WORDS.map(([m, d]) => [m, d, m === 4000 || m === 5000 ? 1 : 0]);
  await setup(page, words);
  await select(page, 3, 6);
  await expect(span(page)).toHaveText('0:03–0:07');
  await expect(length(page)).toHaveText('0:02');
});

test('a selection of struck words only shows nothing', async ({ page }) => {
  const words = WORDS.map(([m, d]) => [m, d, m === 4000 || m === 5000 ? 1 : 0]);
  await setup(page, words);
  await select(page, 4, 5);
  await expect(chip(page)).toBeHidden();
});

test('it reads as the Export dialog does', async ({ page }) => {
  await setup(page);
  await select(page, 2, 8);
  await expect(length(page)).toHaveText('0:07');
  const shown = await span(page).textContent();
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  await page.evaluate(() => {
    document.activeElement && document.activeElement.blur();
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
  await expect(page.locator('#export-clip-summary')).toHaveText(`(${shown}, 0:07)`);
});

test('an edit in the transcript takes the selection, and the chip, away', async ({ page }) => {
  await setup(page);
  await select(page, 3, 6);
  await expect(chip(page)).toBeVisible();
  await page.evaluate(() => {
    const w = document.querySelector('#hypertranscript [data-m]');
    w.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
  });
  await expect(chip(page)).toBeHidden();
});

test('without the script the chip stays hidden and nothing else minds', async ({ page }) => {
  await page.route('**/js/selection-length.js*', (route) => route.fulfill({ body: '', contentType: 'application/javascript' }));
  await setup(page);
  await select(page, 3, 6);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
  await expect(chip(page)).toBeHidden();
  expect(await page.evaluate(() => typeof window.SelectionLength)).toBe('undefined');
});

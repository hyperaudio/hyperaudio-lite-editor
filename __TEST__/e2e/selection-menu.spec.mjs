// #803 — a small bar beside a selection in the transcript: Strike out or
// Unstrike, and Export. It shows once a drag has ended or a double-click has
// selected a word, acts through the toolbar's own paths, and goes with the
// selection, with Escape, with an edit, or when a dialog opens. The
// passage's length stays in the corner pill (selection-length.spec.mjs).
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
const bar = (page) => page.locator('#selection-menu');
const strike = (page) => page.locator('#selection-menu .selection-menu-strike');
const exportBtn = (page) => page.locator('#selection-menu .selection-menu-export');
const word = (page, i) => page.locator('#hypertranscript [data-m]').nth(i);
const isStruck = (page, i) => page.evaluate((i) => (document.querySelectorAll('#hypertranscript [data-m]')[i].style.textDecoration || '').includes('line-through'), i);

const waitForExport = (page) => page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
const closeExport = (page) => page.evaluate(() => {
  const m = document.getElementById('export-modal');
  m.checked = false;
  m.dispatchEvent(new Event('change'));
});

test('nothing selected, nothing shown', async ({ page }) => {
  await setup(page);
  await expect(bar(page)).toBeHidden();
});

test('a selection shows the bar, with Strike out and Export, and it goes with the selection', async ({ page }) => {
  await setup(page);
  await select(page, 3, 6);
  await expect(bar(page)).toBeVisible();
  await expect(strike(page)).toHaveText('Strike out');
  await expect(exportBtn(page)).toBeVisible();
  // the corner pill shows alongside, as before
  await expect(page.locator('#selection-length')).toBeVisible();
  await clear(page);
  await expect(bar(page)).toBeHidden();
});

test('the bar sits just above the selection, centred, outside the transcript', async ({ page }) => {
  await setup(page);
  await select(page, 3, 6);
  await expect(bar(page)).toBeVisible();
  const at = await page.evaluate(() => {
    const r = (b) => ({ top: b.top, bottom: b.bottom, left: b.left, right: b.right });
    return {
      bar: r(document.getElementById('selection-menu').getBoundingClientRect()),
      sel: r(window.getSelection().getRangeAt(0).getBoundingClientRect()),
      insideTranscript: document.getElementById('hypertranscript').contains(document.getElementById('selection-menu')),
      viewport: window.innerWidth,
    };
  });
  expect(at.bar.bottom).toBeLessThanOrEqual(at.sel.top);
  expect(at.sel.top - at.bar.bottom).toBeLessThan(16);
  const barMid = (at.bar.left + at.bar.right) / 2;
  const selMid = (at.sel.left + at.sel.right) / 2;
  expect(Math.abs(barMid - selMid)).toBeLessThan(2);
  expect(at.bar.left).toBeGreaterThanOrEqual(16);
  expect(at.bar.right).toBeLessThanOrEqual(at.viewport - 16);
  expect(at.insideTranscript).toBe(false);
  expect(await page.evaluate(() => document.getElementById('hypertranscript').innerHTML.includes('selection-menu'))).toBe(false);
});

test('a double-click on a word shows the bar for that one word, with Strike out but not Export; a single click shows nothing', async ({ page }) => {
  // real words: a double-click on a one-letter word lands on its space
  await setup(page, WORDS.map(([m, d]) => [m, d, 0, 'speech']));
  await word(page, 5).dblclick();
  await expect(bar(page)).toBeVisible();
  await expect(strike(page)).toBeVisible();
  // a double-click selects as a side effect of playing as often as by choice
  await expect(exportBtn(page)).toBeHidden();
  expect(await page.evaluate(() => window.TranscriptSelection.words().length)).toBe(1);
  await word(page, 8).click();
  await expect(bar(page)).toBeHidden();
  // the same word selected another way is offered for export
  await select(page, 5, 5);
  await expect(exportBtn(page)).toBeVisible();
});

test('the bar waits for the drag to end', async ({ page }) => {
  await setup(page);
  const a = await word(page, 3).boundingBox();
  const b = await word(page, 6).boundingBox();
  await page.mouse.move(a.x + 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 8 });
  await page.waitForTimeout(100);
  // selected, but still held: no bar
  expect(await page.evaluate(() => window.TranscriptSelection.words().length)).toBeGreaterThan(1);
  await expect(bar(page)).toBeHidden();
  await page.mouse.up();
  await expect(bar(page)).toBeVisible();
});

test('Strike out from the bar strikes the selected words, through the toolbar path, and the bar then offers Unstrike', async ({ page }) => {
  await setup(page);
  await select(page, 3, 5);
  await expect(strike(page)).toHaveText('Strike out');
  await strike(page).click();
  expect(await isStruck(page, 3)).toBe(true);
  expect(await isStruck(page, 5)).toBe(true);
  expect(await isStruck(page, 6)).toBe(false);
  // the kept sections followed, as from the toolbar
  const sections = await page.evaluate(() => window.getPlayableSections());
  expect(sections.some((s) => Math.abs(s.start - 6) < 0.01)).toBe(true);
  // the same words, selected again: all struck, so Unstrike and no export
  await select(page, 3, 5);
  await expect(strike(page)).toHaveText('Unstrike');
  await expect(exportBtn(page)).toBeHidden();
  await strike(page).click();
  expect(await isStruck(page, 4)).toBe(false);
});

test('a mixed selection offers Strike out, since a strike strikes the rest', async ({ page }) => {
  const words = WORDS.map(([m, d]) => [m, d, m === 4000 || m === 5000 ? 1 : 0]);
  await setup(page, words);
  await select(page, 3, 6);
  await expect(strike(page)).toHaveText('Strike out');
  await expect(exportBtn(page)).toBeVisible();
});

test('Export from the bar opens the export dialog with the selection chosen, one word included (#776)', async ({ page }) => {
  await setup(page);
  await select(page, 5, 5);
  await expect(bar(page)).toBeVisible();
  await exportBtn(page).click();
  await waitForExport(page);
  expect(await page.evaluate(() => document.getElementById('export-modal').checked)).toBe(true);
  expect(await page.evaluate(() => document.getElementById('export-source-clip').checked)).toBe(true);
  await expect(page.locator('#export-clip-summary')).toHaveText('(0:05–0:06, 0:01)');
  await expect(bar(page)).toBeHidden();
  await closeExport(page);
  // the toolbar route keeps #776: one word offered, not chosen
  await select(page, 7, 7);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  await page.evaluate(() => {
    document.activeElement && document.activeElement.blur();
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await waitForExport(page);
  expect(await page.evaluate(() => document.getElementById('export-source-clip').checked)).toBe(false);
  await expect(bar(page)).toBeHidden();
});

test('Escape hides the bar until the selection changes', async ({ page }) => {
  await setup(page);
  await select(page, 3, 6);
  await expect(bar(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
  await page.evaluate(() => window.SelectionMenu.render());
  await expect(bar(page)).toBeHidden();
  await select(page, 3, 7);
  await expect(bar(page)).toBeVisible();
});

test('an edit in the transcript takes the selection, and the bar, away', async ({ page }) => {
  await setup(page);
  await select(page, 3, 6);
  await expect(bar(page)).toBeVisible();
  await page.evaluate(() => {
    const w = document.querySelector('#hypertranscript [data-m]');
    w.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
  });
  await expect(bar(page)).toBeHidden();
});

test('a read-only transcript offers Export but not Strike out', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => document.documentElement.classList.add('ha-readonly'));
  await select(page, 3, 6);
  await expect(bar(page)).toBeVisible();
  await expect(strike(page)).toBeHidden();
  await expect(exportBtn(page)).toBeVisible();
});

test('without the script no bar shows and nothing else minds', async ({ page }) => {
  await page.route('**/js/selection-menu.js*', (route) => route.fulfill({ body: '', contentType: 'application/javascript' }));
  await setup(page);
  await select(page, 3, 6);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
  await expect(bar(page)).toBeHidden();
  expect(await page.evaluate(() => typeof window.SelectionMenu)).toBe('undefined');
  // the pill and the toolbar's strike still work on the selection
  await expect(page.locator('#selection-length')).toBeVisible();
  await page.click('#strikethrough');
  expect(await isStruck(page, 4)).toBe(true);
});

test('a setting on the Application tab turns the bar off (#803)', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.HyperaudioSettings.set('selectionBar', false));
  await select(page, 3, 6);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
  await expect(bar(page)).toBeHidden();
  // the pill is not part of the bar, and still shows
  await expect(page.locator('#selection-length')).toBeVisible();
  await page.evaluate(() => window.HyperaudioSettings.set('selectionBar', true));
  await select(page, 3, 7);
  await expect(bar(page)).toBeVisible();
});

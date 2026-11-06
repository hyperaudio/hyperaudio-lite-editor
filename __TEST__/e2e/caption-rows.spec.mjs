// #773 — the caption editor's rows. Each cue was a stack of six rows and seven
// controls, 300px tall, with nothing marking the cue that was playing and a
// time set by typing twelve characters. One cue is one row now: play, the two
// times, the text in one box of two lines, the reading rate and a menu. The
// playing cue is marked and kept in view, a time is set from the playhead or
// nudged from the keyboard, and the row folds on a narrow screen.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';

const AXE_PATH = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const ROW = '#captions-display .caption';

const openCaptions = async (page) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.click('#caption-editor-btn');
  await page.waitForSelector(ROW);
  // the "captions have been edited" notice, should a previous test's state leak
  const divergence = page.locator('#project-dialog.modal-open');
  if (await divergence.isVisible()) await page.click('#project-dialog-confirm');
};

// the player's clock, stood in for: tests set it and fire timeupdate
const fakeClock = (page) => page.evaluate(() => {
  const v = document.getElementById('hyperplayer');
  let at = 0;
  Object.defineProperty(v, 'currentTime', { configurable: true, get: () => at, set: (x) => { at = x; } });
});
const tick = (page, at) => page.evaluate((t) => {
  const v = document.getElementById('hyperplayer');
  v.currentTime = t;
  v.dispatchEvent(new Event('timeupdate'));
}, at);
const clock = (page) => page.evaluate(() => document.getElementById('hyperplayer').currentTime);

const rect = (page, selector) => page.evaluate((sel) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
}, selector);
const nthStart = (page, n) => page.evaluate((i) => {
  const v = document.querySelectorAll('#captions-display .caption')[i].querySelector('.start').value;
  return window.CaptionRows.seconds(v);
}, n);

test('one cue is one row, with the text beside the times', async ({ page }) => {
  await openCaptions(page);
  const row = await rect(page, `${ROW}:first-child`);
  expect(row.height).toBeLessThan(100);
  const times = await rect(page, `${ROW}:first-child .caption-times`);
  const text = await rect(page, `${ROW}:first-child textarea.lines`);
  expect(Math.abs(text.top - times.top)).toBeLessThan(12);
  expect(text.left).toBeGreaterThan(times.right);
  // the text boxes share one right edge, whatever each row's rate reads
  const rights = await page.$$eval(`${ROW} textarea.lines`, (els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
  expect(new Set(rights).size).toBe(1);
  // the old stack is gone: no line inputs, no button group
  expect(await page.locator(`${ROW}:first-child input`).count()).toBe(2);
  expect(await page.locator(`${ROW}:first-child [data-caption-action]`).count()).toBe(3);
});

test('below 700px the row folds: the text goes under the times', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await openCaptions(page);
  const times = await rect(page, `${ROW}:first-child .caption-times`);
  const text = await rect(page, `${ROW}:first-child textarea.lines`);
  expect(text.top).toBeGreaterThanOrEqual(times.bottom - 2);
  const rate = await rect(page, `${ROW}:first-child .caption-rate`);
  expect(Math.abs(rate.top - times.top)).toBeLessThan(12);
});

test('the playing cue is marked and kept in view', async ({ page }) => {
  await openCaptions(page);
  await fakeClock(page);
  const count = await page.locator(ROW).count();
  expect(count).toBeGreaterThan(12);
  const inside = (await nthStart(page, 10)) + 0.05;
  await tick(page, inside);
  await expect(page.locator(`${ROW}:nth-child(11)`)).toHaveClass(/caption-current/);
  expect(await page.locator('.caption-current').count()).toBe(1);
  const holder = await rect(page, '.transcript-holder');
  const row = await rect(page, `${ROW}:nth-child(11)`);
  expect(row.top).toBeGreaterThanOrEqual(holder.top - 1);
  expect(row.bottom).toBeLessThanOrEqual(holder.bottom + 1);
  // and the mark moves on
  await tick(page, (await nthStart(page, 2)) + 0.05);
  await expect(page.locator(`${ROW}:nth-child(3)`)).toHaveClass(/caption-current/);
  expect(await page.locator('.caption-current').count()).toBe(1);
});

test('while a row is being edited the view stays put', async ({ page }) => {
  await openCaptions(page);
  await fakeClock(page);
  await page.locator(`${ROW}:first-child textarea.lines`).click();
  const before = await page.evaluate(() => document.querySelector('.transcript-holder').scrollTop);
  await tick(page, (await nthStart(page, 12)) + 0.05);
  await expect(page.locator(`${ROW}:nth-child(13)`)).toHaveClass(/caption-current/);
  expect(await page.evaluate(() => document.querySelector('.transcript-holder').scrollTop)).toBe(before);
});

test('clicking a time seeks there, an Out just before it', async ({ page }) => {
  await openCaptions(page);
  await fakeClock(page);
  const start = await nthStart(page, 2);
  await page.locator(`${ROW}:nth-child(3) .start`).click();
  expect(await clock(page)).toBeCloseTo(start, 3);
  const end = await page.evaluate(() => window.CaptionRows.seconds(
    document.querySelectorAll('#captions-display .caption')[2].querySelector('.end').value));
  await page.locator(`${ROW}:nth-child(3) .end`).click();
  expect(await clock(page)).toBeCloseTo(end - 0.1, 3);
});

test('Enter moves to the second line, a third line is refused, and each line is counted', async ({ page }) => {
  await openCaptions(page);
  const area = page.locator(`${ROW}:first-child textarea.lines`);
  await area.fill('');
  await area.click();
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.keyboard.type('three');
  expect(await area.inputValue()).toBe('one\ntwothree');
  const counts = page.locator(`${ROW}:first-child .caption-count`);
  await expect(counts.nth(0)).toHaveText('3');
  await expect(counts.nth(1)).toHaveText('8');
  // the track was written from the box: both lines, nothing more
  const vtt = await page.evaluate(() => decodeURIComponent(document.getElementById('hyperplayer-vtt').src.split(',')[1]));
  expect(vtt).toContain('one\ntwothree\n\n');
});

test('a pasted third line folds onto the second', async ({ page }) => {
  await openCaptions(page);
  const area = page.locator(`${ROW}:first-child textarea.lines`);
  await area.evaluate((el) => {
    el.value = 'first\nsecond\nthird\nfourth';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(await area.inputValue()).toBe('first\nsecond third fourth');
});

test('the count turns red past 42 characters', async ({ page }) => {
  await openCaptions(page);
  const area = page.locator(`${ROW}:first-child textarea.lines`);
  const first = page.locator(`${ROW}:first-child .caption-count`).first();
  await area.fill('x'.repeat(42));
  await expect(first).toHaveText('42');
  await expect(first).not.toHaveClass(/caption-count-over/);
  await area.fill('x'.repeat(43));
  await expect(first).toHaveText('43');
  await expect(first).toHaveClass(/caption-count-over/);
});

test('In and Out are set from the playhead with Alt and a bracket', async ({ page }) => {
  await openCaptions(page);
  await fakeClock(page);
  await tick(page, 75.5);
  await page.locator(`${ROW}:nth-child(2) textarea.lines`).click();
  await page.keyboard.press('Alt+BracketRight');
  await expect(page.locator(`${ROW}:nth-child(2) .end`)).toHaveValue('00:01:15.500');
  await page.keyboard.press('Alt+BracketLeft');
  await expect(page.locator(`${ROW}:nth-child(2) .start`)).toHaveValue('00:01:15.500');
  // the edit reached the one door: the project is marked dirty
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);
});

test('Alt+Up and Alt+Down nudge a focused time by a tenth of a second', async ({ page }) => {
  await openCaptions(page);
  const start = page.locator(`${ROW}:nth-child(2) .start`);
  await start.fill('00:00:12.345');
  await start.click();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(start).toHaveValue('00:00:12.445');
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(start).toHaveValue('00:00:12.245');
});

test('the menu holds insert, merge and delete, the last row withholds merge, and an item closes it', async ({ page }) => {
  await openCaptions(page);
  const last = page.locator(ROW).last();
  await last.scrollIntoViewIfNeeded();
  await last.locator('details.caption-menu').evaluate((el) => { el.open = true; });
  await expect(last.locator('[data-caption-action="merge"]')).toBeDisabled();
  await expect(last.locator('[data-caption-action="insert"]')).toBeEnabled();
  await expect(last.locator('[data-caption-action="delete"]')).toBeEnabled();
  // and the open menu is on top, not clipped by its row's box
  await expect.poll(() => last.locator('[data-caption-action="delete"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === el;
  })).toBe(true);
  // a menu item closes its menu
  await page.locator(`${ROW}:first-child details.caption-menu`).evaluate((el) => { el.open = true; });
  await page.locator(`${ROW}:first-child [data-caption-action="insert"]`).evaluate((el) => el.click());
  expect(await page.locator(`${ROW}:first-child details.caption-menu`).evaluate((el) => el.open)).toBe(false);
});

test('a click elsewhere, or Escape, closes an open menu', async ({ page }) => {
  await openCaptions(page);
  const menu = page.locator(`${ROW}:nth-child(2) details.caption-menu`);
  const isOpen = () => menu.evaluate((el) => el.open);
  await menu.locator('summary').click();
  expect(await isOpen()).toBe(true);
  await page.locator(`${ROW}:nth-child(5) textarea.lines`).click();
  expect(await isOpen()).toBe(false);
  await menu.locator('summary').click();
  expect(await isOpen()).toBe(true);
  await page.keyboard.press('Escape');
  expect(await isOpen()).toBe(false);
  // opening another closes the first
  await menu.locator('summary').click();
  await page.locator(`${ROW}:nth-child(7) details.caption-menu summary`).click();
  expect(await isOpen()).toBe(false);
  expect(await page.locator(`${ROW}:nth-child(7) details.caption-menu`).evaluate((el) => el.open)).toBe(true);
});

test('a new caption takes the gap it is inserted into, and the caret goes to its text', async ({ page }) => {
  await openCaptions(page);
  await page.locator(`${ROW}:first-child .end`).fill('00:00:03.000');
  await page.locator(`${ROW}:nth-child(2) .start`).fill('00:00:05.000');
  await page.locator(`${ROW}:first-child [data-caption-action="insert"]`).evaluate((el) => el.click());
  const added = page.locator(`${ROW}:nth-child(2)`);
  await expect(added.locator('.start')).toHaveValue('00:00:03.040');
  await expect(added.locator('.end')).toHaveValue('00:00:04.960');
  await expect(added.locator('textarea.lines')).toBeFocused();
  await expect(added).toHaveClass(/caption-new/);
  // after the last caption it runs for two seconds
  const last = page.locator(ROW).last();
  await last.locator('.end').fill('00:01:00.000');
  await last.locator('[data-caption-action="insert"]').evaluate((el) => el.click());
  await expect(page.locator(ROW).last().locator('.start')).toHaveValue('00:01:00.040');
  await expect(page.locator(ROW).last().locator('.end')).toHaveValue('00:01:02.040');
  // a gap too small to hold one still gives it a moment
  await page.locator(`${ROW}:first-child .end`).fill('00:00:03.000');
  await page.locator(`${ROW}:nth-child(2) .start`).fill('00:00:03.010');
  await page.locator(`${ROW}:first-child [data-caption-action="insert"]`).evaluate((el) => el.click());
  await expect(page.locator(`${ROW}:nth-child(2) .start`)).toHaveValue('00:00:03.040');
  await expect(page.locator(`${ROW}:nth-child(2) .end`)).toHaveValue('00:00:03.240');
});

test('insert, merge and delete still work from the menu', async ({ page }) => {
  await openCaptions(page);
  const before = await page.locator(ROW).count();
  await page.locator(`${ROW}:first-child [data-caption-action="insert"]`).evaluate((el) => el.click());
  expect(await page.locator(ROW).count()).toBe(before + 1);
  await page.locator(`${ROW}:nth-child(2) textarea.lines`).fill('inserted');
  await page.locator(`${ROW}:first-child [data-caption-action="merge"]`).evaluate((el) => el.click());
  expect(await page.locator(ROW).count()).toBe(before);
  expect(await page.locator(`${ROW}:first-child textarea.lines`).inputValue()).toContain('inserted');
  await page.locator(`${ROW}:first-child [data-caption-action="delete"]`).evaluate((el) => el.click());
  expect(await page.locator(ROW).count()).toBe(before - 1);
});

test('the text survives a trip to the transcript and back', async ({ page }) => {
  await openCaptions(page);
  await page.locator(`${ROW}:first-child textarea.lines`).fill('kept line\nand its second');
  await page.click('#transcript-editor-btn');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.click('#caption-editor-btn');
  await page.waitForSelector(ROW);
  const divergence = page.locator('#project-dialog.modal-open');
  if (await divergence.isVisible()) await page.click('#project-dialog-confirm');
  expect(await page.locator(`${ROW}:first-child textarea.lines`).inputValue()).toBe('kept line\nand its second');
  await expect(page.locator(`${ROW}:first-child .caption-count`).nth(1)).toHaveText('14');
});

test('the rows pass the accessibility rules the editor holds itself to', async ({ page }) => {
  await openCaptions(page);
  await page.locator(`${ROW}:first-child details.caption-menu`).evaluate((el) => { el.open = true; });
  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document.getElementById('captions-display'), {
      runOnly: { type: 'rule', values: ['label', 'button-name', 'aria-required-children', 'aria-allowed-role',
        'aria-required-parent', 'form-field-multiple-labels', 'color-contrast', 'aria-hidden-focus'] },
    });
    return result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5) }));
  });
  expect(violations).toEqual([]);
});

test('the dead captions dialog is gone from the page', async ({ page }) => {
  await page.goto('/index.html');
  expect(await page.locator('#captions-modal, #regenerate-btn, #caption-editor').count()).toBe(0);
});

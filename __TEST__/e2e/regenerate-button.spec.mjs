// The caption editor's floating Regenerate button: icon only, so it does not
// cover the caption rows it floats over, with the words in a tooltip and the
// confirmation modal behind it unchanged.
import { test, expect } from '@playwright/test';

const LABEL = 'Regenerate captions from transcript';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
});

test('the button is an icon with the words in a tooltip, and is still named for a reader', async ({ page }) => {
  const state = await page.evaluate(() => {
    const el = document.getElementById('regenerate-float-btn');
    const tip = getComputedStyle(el, '::before');
    return {
      text: el.textContent.trim(),
      icon: el.querySelector('svg') !== null,
      tip: el.getAttribute('data-tip'),
      label: el.getAttribute('aria-label'),
      opens: el.getAttribute('for'),
      tabbable: el.tabIndex === 0,          // a11y.js wires label-buttons
      tipRight: tip.right,                  // right-anchored: it sits at the edge
      tipTransform: tip.transform,
    };
  });
  expect(state.text).toBe('');
  expect(state.icon).toBe(true);
  expect(state.tip).toBe(LABEL);
  expect(state.label).toBe(LABEL);
  expect(state.opens).toBe('regenerate-captions-modal');
  expect(state.tabbable).toBe(true);
  expect(state.tipRight).toBe('0px');
  expect(state.tipTransform).toBe('none');
});

test('it stays inside the viewport with its tooltip', async ({ page }) => {
  const box = await page.locator('#regenerate-float-btn').boundingBox();
  const width = await page.evaluate(() => window.innerWidth);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  // square, now that the words have gone
  expect(Math.abs(box.width - box.height)).toBeLessThan(2);
});

test('it still asks before throwing caption edits away', async ({ page }) => {
  await page.click('#regenerate-float-btn');
  expect(await page.evaluate(() => document.getElementById('regenerate-captions-modal').checked)).toBe(true);
  const dialog = page.locator('#regenerate-captions-modal + .modal');
  await expect(dialog).toContainText('Any changes you made to the captions will be lost');
  await expect(dialog.locator('#regenerate-captions')).toHaveText('Confirm');

  // and confirming rebuilds the rows
  await page.click('#regenerate-captions');
  await expect.poll(() => page.evaluate(() =>
    document.querySelectorAll('#captions-display .caption').length)).toBeGreaterThan(0);
});

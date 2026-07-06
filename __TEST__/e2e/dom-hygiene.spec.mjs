// DOM hygiene: element ids must be unique — duplicate ids make
// getElementById/querySelector silently return whichever comes first in the
// DOM, so selectors hit the right element only by accident of markup order
// (#379: two elements shared id="regenerate-btn"). Checked on load and again
// in caption mode, which injects extra UI at runtime.
import { test, expect } from '@playwright/test';

const duplicateIds = (page) => page.evaluate(() => {
  const seen = new Map();
  document.querySelectorAll('[id]').forEach((el) => {
    seen.set(el.id, (seen.get(el.id) || 0) + 1);
  });
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`);
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('no duplicate element ids on load', async ({ page }) => {
  expect(await duplicateIds(page)).toEqual([]);
});

test('no duplicate element ids in caption mode; regenerate controls distinct (#379)', async ({ page }) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#regenerate-float-btn', { timeout: 30000 });

  expect(await duplicateIds(page)).toEqual([]);

  // the floating button and the captions-modal button are separate elements
  const roles = await page.evaluate(() => {
    const float = document.getElementById('regenerate-float-btn');
    const modal = document.getElementById('regenerate-btn');
    const cs = getComputedStyle(float);
    const bb = float.getBoundingClientRect();
    const topEl = document.elementFromPoint(bb.x + bb.width / 2, bb.y + bb.height / 2);
    return {
      floatIsLabel: float.tagName === 'LABEL',
      floatFixed: cs.position === 'fixed',
      floatZ: cs.zIndex,
      floatClickable: topEl === float || float.contains(topEl),
      modalIsButton: modal !== null && modal.tagName === 'BUTTON',
      distinct: float !== modal,
    };
  });
  expect(roles).toEqual({
    floatIsLabel: true,
    floatFixed: true,
    floatZ: '20',
    floatClickable: true,
    modalIsButton: true,
    distinct: true,
  });
});

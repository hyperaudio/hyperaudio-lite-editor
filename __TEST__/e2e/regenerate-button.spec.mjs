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

// #862: in a narrow window the button covered the playing caption's reading
// rate and menu. It is smaller now, and a caption brought into view at the
// top, as a seek back does, stops below it
test('in a narrow window, a caption scrolled back into view stops below the button', async ({ page }) => {
  await page.setViewportSize({ width: 540, height: 800 });
  // the button slides to its narrow-window place: wait until it has settled
  const place = () => page.evaluate(() => document.getElementById('regenerate-float-btn').getBoundingClientRect().top);
  let last = -1;
  await expect.poll(async () => { const now = await place(); const settled = now === last; last = now; return settled; },
    { intervals: [100, 100, 100, 200, 300] }).toBe(true);
  await page.evaluate(() => {
    const p = document.getElementById('hyperplayer');
    let at = 0;
    Object.defineProperty(p, 'currentTime', { configurable: true, get: () => at, set: (x) => { at = x; } });
  });
  // the list scrolled down, then the media back to the second caption
  await page.evaluate(() => {
    const holder = document.querySelector('#captions-display').closest('.transcript-holder');
    holder.scrollTop = holder.scrollHeight;
  });
  const start = await page.evaluate(() => window.CaptionRows.seconds(
    document.querySelectorAll('#captions-display .caption')[1].querySelector('.start').value));
  await page.evaluate((t) => {
    const p = document.getElementById('hyperplayer');
    p.currentTime = t + 0.1;
    p.dispatchEvent(new Event('timeupdate'));
  }, start);
  await expect(page.locator('#captions-display .caption').nth(1)).toHaveClass(/caption-current/);

  const covered = await page.evaluate(() => {
    const b = document.getElementById('regenerate-float-btn').getBoundingClientRect();
    const row = document.querySelector('#captions-display .caption-current');
    return [...row.querySelectorAll('.caption-rate, .caption-menu, .start, .end')].filter((e) => {
      const q = e.getBoundingClientRect();
      return q.width > 0 && q.left < b.right && q.right > b.left && q.top < b.bottom && q.bottom > b.top;
    }).map((e) => e.className);
  });
  expect(covered).toEqual([]);
  // and nothing else sits on the button
  expect(await page.evaluate(() => {
    const btn = document.getElementById('regenerate-float-btn');
    const r = btn.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return btn === at || btn.contains(at);
  })).toBe(true);
});

// #862: after a caption import, at the top of the list, the first caption
// starts below the button
test('after a caption import, nothing in the first caption sits under the button', async ({ page }, testInfo) => {
  const fs = await import('node:fs');
  const file = testInfo.outputPath('short.vtt');
  fs.writeFileSync(file, 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOne two three.\n\n00:00:04.000 --> 00:00:06.500\nFour five six.\n');
  await page.setViewportSize({ width: 540, height: 800 });
  // back to the transcript to import, as someone would, then to the captions
  await page.click('#transcript-editor-btn');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(() => { document.getElementById('file-import-vtt-dialog').checked = true; });
  await page.setInputFiles('#vtt', file);
  await page.click('#file-import-vtt');
  await page.waitForFunction(() => document.getElementById('hypertranscript').textContent.includes('Four'));
  await page.click('#caption-editor-btn');
  const divergence = page.locator('#project-dialog.modal-open');
  if (await divergence.isVisible()) await page.click('#project-dialog-confirm');
  await expect(page.locator('#captions-display .caption')).toHaveCount(2);
  // the button slides to its narrow-window place: wait until it has settled
  const place = () => page.evaluate(() => document.getElementById('regenerate-float-btn').getBoundingClientRect().top);
  let last = -1;
  await expect.poll(async () => { const now = await place(); const settled = now === last; last = now; return settled; },
    { intervals: [100, 100, 100, 200, 300] }).toBe(true);

  const covered = await page.evaluate(() => {
    const b = document.getElementById('regenerate-float-btn').getBoundingClientRect();
    const row = document.querySelector('#captions-display .caption');
    return [...row.querySelectorAll('.caption-rate, .caption-menu, .start, .end')].filter((e) => {
      const q = e.getBoundingClientRect();
      return q.width > 0 && q.left < b.right && q.right > b.left && q.top < b.bottom && q.bottom > b.top;
    }).map((e) => e.className);
  });
  expect(covered).toEqual([]);
});

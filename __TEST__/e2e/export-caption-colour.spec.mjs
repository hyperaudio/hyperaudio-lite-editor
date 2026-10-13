// #729 — the colour of the word being spoken in burned-in captions can be
// chosen. Offered while captions are being burned, remembered with the other
// export options, and the default stays the yellow it always was.
import { test, expect } from '@playwright/test';

const FIXTURE = '/__TEST__/fixtures/video-640x360.mp4';

const setup = async (page) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate((src) => { document.getElementById('hyperplayer').src = src; }, FIXTURE);
  await page.waitForFunction(() => document.getElementById('hyperplayer').readyState >= 2);
  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
};

const settle = (page, id, value) => page.evaluate(([i, v]) => {
  const el = document.getElementById(i);
  if (el.type === 'radio' || el.type === 'checkbox') el.checked = v; else el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, value]);

// the overlay drawn on a black frame with a one-word cue at its start: the
// colour of the brightest pixels is the active word's
const activeWordColour = (page, accent) => page.evaluate((accent) => {
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const c = canvas.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, 320, 180);
  const cue = { start: 0, end: 5, lines: [[{ text: 'HELLO', start: 0 }]] };
  window.MediaExportCaptions.drawCaptionOverlay(c, 1, [cue], 320, 180, accent ? { accent } : undefined);
  const d = c.getImageData(0, 0, 320, 180).data;
  let best = null;
  for (let i = 0; i < d.length; i += 4) {
    const sum = d[i] + d[i + 1] + d[i + 2];
    if (best === null || sum > best.sum) best = { sum, r: d[i], g: d[i + 1], b: d[i + 2] };
  }
  return best;
}, accent);

test('the colour row appears with burning, and the chosen colour is remembered', async ({ page }) => {
  await setup(page);
  const row = page.locator('#export-caption-colour-row');
  const video = await page.evaluate(() => [...document.querySelectorAll('#export-format option')].map((o) => o.value).find((v) => v === 'mp4' || v === 'webm'));
  test.skip(!video, 'no video encoder in this browser');
  await page.selectOption('#export-format', video);
  await expect(row).toBeHidden();                 // burning off: no colour to choose
  await settle(page, 'export-burn', true);
  await expect(row).toBeVisible();
  expect(await page.inputValue('#export-caption-colour')).toBe('#ffe14d'); // the yellow it always was
  await settle(page, 'export-caption-colour', '#ff2d55');
  await page.reload();
  await setup(page);
  await page.selectOption('#export-format', video);
  expect(await page.inputValue('#export-caption-colour')).toBe('#ff2d55');
  await expect(row).toBeVisible();                // burning was remembered too
});

test('the overlay paints the active word in the chosen colour, yellow by default', async ({ page }) => {
  await setup(page);
  const yellow = await activeWordColour(page, undefined);
  expect(yellow.r).toBeGreaterThan(200); expect(yellow.g).toBeGreaterThan(180); expect(yellow.b).toBeLessThan(120);
  const red = await activeWordColour(page, '#ff0000');
  expect(red.r).toBeGreaterThan(200); expect(red.g).toBeLessThan(80); expect(red.b).toBeLessThan(80);
  const bad = await activeWordColour(page, 'not-a-colour'); // falls back to the default
  expect(bad.b).toBeLessThan(120); expect(bad.g).toBeGreaterThan(180);
});

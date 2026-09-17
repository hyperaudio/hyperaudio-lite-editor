// Characters per line, in Settings, feeding caption generation. caption.js
// takes a maximum and a minimum; the minimum is where a mid-sentence break
// becomes allowed, so it has to stay below whatever maximum is chosen.
import { test, expect } from '@playwright/test';

const lineLengths = (page) => page.evaluate(() => {
  const vtt = window.HyperaudioSave.getCaptionsVtt();
  return vtt.split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.includes('-->') && l !== 'WEBVTT')
    .map((l) => l.trim().length);
});

const regenerate = (page) => page.evaluate(() => hyperaudioGenerateCaptionsFromTranscript());

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('the default is 32 characters, and generated lines respect it', async ({ page }) => {
  expect(await page.evaluate(() => window.HyperaudioSettings.captionLineLengths())).toEqual({ max: 32, min: 21 });
  expect(await page.evaluate(() => window.HyperaudioSettings.get('captionLineLength'))).toBe(32);

  await regenerate(page);
  const lengths = await lineLengths(page);
  expect(lengths.length).toBeGreaterThan(5);
  // caption.js may overshoot to keep an orphan word company (its tolerance is
  // 12 characters), so the ceiling is loose; what matters is that the typical
  // line sits at the setting rather than above it
  expect(Math.max(...lengths)).toBeLessThanOrEqual(32 + 14);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  expect(mean).toBeLessThanOrEqual(32);
});

test('a shorter setting produces shorter lines on the next generation', async ({ page }) => {
  await regenerate(page);
  const at32 = await lineLengths(page);

  await page.evaluate(() => window.HyperaudioSettings.set('captionLineLength', 20));
  await regenerate(page);
  const at20 = await lineLengths(page);

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  expect(mean(at20)).toBeLessThan(mean(at32));
  expect(at20.length).toBeGreaterThan(at32.length);   // more, shorter lines
});

test('the minimum follows the maximum down, so a break is always possible', async ({ page }) => {
  const pairs = await page.evaluate(() => {
    const out = {};
    [80, 37, 32, 24, 16].forEach((max) => {
      window.HyperaudioSettings.set('captionLineLength', max);
      out[max] = window.HyperaudioSettings.captionLineLengths();
    });
    return out;
  });
  expect(pairs['37']).toEqual({ max: 37, min: 21 });
  expect(pairs['32']).toEqual({ max: 32, min: 21 });
  expect(pairs['24']).toEqual({ max: 24, min: 16 });
  expect(pairs['16']).toEqual({ max: 16, min: 8 });
  Object.values(pairs).forEach(({ max, min }) => expect(min).toBeLessThan(max));
});

test('the field clamps what it is given rather than trusting it', async ({ page }) => {
  await page.evaluate(() => {
    const m = document.getElementById('settings-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
    // the sections collapse now; a test reaching a control has to open it,
    // as a user does
    document.querySelectorAll('#settings-modal + .modal details').forEach((d) => { d.open = true; });
  });
  const field = page.locator('#setting-caption-line-length');
  await expect(field).toHaveValue('32');

  await field.fill('900');
  await field.dispatchEvent('change');
  await expect(field).toHaveValue('80');
  expect(await page.evaluate(() => window.HyperaudioSettings.get('captionLineLength'))).toBe(80);

  await field.fill('2');
  await field.dispatchEvent('change');
  await expect(field).toHaveValue('16');

  // a number field will not accept letters from a user, but an empty one
  // reads back as '' — that must land on the default, not NaN
  await page.evaluate(() => {
    const el = document.getElementById('setting-caption-line-length');
    el.value = '';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(field).toHaveValue('32');
});

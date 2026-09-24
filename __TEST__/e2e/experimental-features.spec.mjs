// Settings ▸ Experimental features (js/experimental-features.js): the larger
// Whisper models are offered only with the switch on, and a saved choice of
// one falls back to Base whenever they are not.
import { test, expect } from '@playwright/test';

const models = (page) => page.evaluate(() => [...document.querySelectorAll('#model-name-input option')].map((o) => o.value));
const chosen = (page) => page.evaluate(() => document.getElementById('model-name-input').value);
const flip = (page) => page.evaluate(() => document.getElementById('setting-experimental').click());
const ready = async (page) => { await page.goto('/index.html'); await page.waitForSelector('#hypertranscript [data-m]'); };

test('off by default: Small and Turbo are not offered, and the switch carries a warning', async ({ page }) => {
  await ready(page);
  expect(await models(page)).toEqual(['tiny', 'base']);
  expect(await page.evaluate(() => document.getElementById('setting-experimental').checked)).toBe(false);
  await expect(page.locator('#settings-panel-application .settings-hint-warning'))
    .toContainText('may cause unexpected results');
});

test('switching on offers them in place, and it survives a reload', async ({ page }) => {
  await ready(page);
  expect(await models(page)).toEqual(['tiny', 'base']);
  await flip(page);
  expect(await models(page)).toEqual(['tiny', 'base', 'small', 'turbo']);
  await ready(page);
  expect(await models(page)).toEqual(['tiny', 'base', 'small', 'turbo']);
  expect(await page.evaluate(() => document.getElementById('setting-experimental').checked)).toBe(true);
});

test('a saved choice of Small is kept while the switch is on, and falls back to Base when it goes off', async ({ page }) => {
  await ready(page);
  await flip(page);
  await page.evaluate(() => {
    const select = document.getElementById('model-name-input');
    select.value = 'small';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await ready(page);
  await expect.poll(() => chosen(page)).toBe('small');   // restored on the tick after load
  await flip(page);                                       // off, with Small selected
  expect(await models(page)).toEqual(['tiny', 'base']);
  expect(await chosen(page)).toBe('base');
  await ready(page);
  await expect.poll(() => chosen(page)).toBe('base');     // the fallback was saved
});

test('a saved choice of Small from before the switch existed loads as Base', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('hyperaudioTranscribePrefs', JSON.stringify({ values: { 'model-name-input': 'small' }, checks: {} }));
  });
  await ready(page);
  await page.waitForTimeout(100);
  expect(await chosen(page)).toBe('base');
});

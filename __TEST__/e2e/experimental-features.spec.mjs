// Settings ▸ Experimental features (js/experimental-features.js). Nothing in
// the shipped page is experimental today, so the switch's row is hidden and
// the larger Whisper models are always offered (#462 let them out). The
// mechanism is tested with a stand-in: an experimental option added to the
// Whisper menu before the module runs.
import { test, expect } from '@playwright/test';

const models = (page) => page.evaluate(() => [...document.querySelectorAll('#model-name-input option')].map((o) => o.value));
const chosen = (page) => page.evaluate(() => document.getElementById('model-name-input').value);
const flip = (page) => page.evaluate(() => document.getElementById('setting-experimental').click());
const ready = async (page) => { await page.goto('/index.html'); await page.waitForSelector('#hypertranscript [data-m]'); };
const rowShown = (page) => page.evaluate(() => getComputedStyle(document.getElementById('setting-experimental-row')).display !== 'none');

// an option marked experimental, added before experimental-features.js runs
const withStandIn = (page) => page.addInitScript(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('model-name-input');
    const option = document.createElement('option');
    option.value = 'trial'; option.textContent = 'Trial model'; option.dataset.experimental = '';
    select.appendChild(option);
  });
});

test('with nothing experimental, the switch is hidden and Small and Turbo are always offered', async ({ page }) => {
  await ready(page);
  expect(await models(page)).toEqual(['tiny', 'base', 'small', 'turbo']);
  expect(await rowShown(page)).toBe(false);
});

test('an experimental option is out until the switch is on, and the switch carries a warning', async ({ page }) => {
  await withStandIn(page);
  await ready(page);
  expect(await rowShown(page)).toBe(true);
  expect(await models(page)).toEqual(['tiny', 'base', 'small', 'turbo']);
  await expect(page.locator('#settings-panel-application .settings-hint-warning')).toContainText('may cause unexpected results');
  await flip(page);
  expect(await models(page)).toEqual(['tiny', 'base', 'small', 'turbo', 'trial']);
  await ready(page);
  expect(await models(page)).toEqual(['tiny', 'base', 'small', 'turbo', 'trial']);   // survives a reload
});

test('a saved experimental choice is kept while the switch is on, and falls back to Base when it goes off', async ({ page }) => {
  await withStandIn(page);
  await ready(page);
  await flip(page);
  await page.evaluate(() => {
    const select = document.getElementById('model-name-input');
    select.value = 'trial';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await ready(page);
  await expect.poll(() => chosen(page)).toBe('trial');
  await flip(page);
  expect(await models(page)).toEqual(['tiny', 'base', 'small', 'turbo']);
  expect(await chosen(page)).toBe('base');
  await ready(page);
  await expect.poll(() => chosen(page)).toBe('base');
});

test('a saved choice of Small, from while it was experimental, is restored', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('hyperaudioTranscribePrefs', JSON.stringify({ values: { 'model-name-input': 'small' }, checks: {} }));
  });
  await ready(page);
  await expect.poll(() => chosen(page)).toBe('small');
});

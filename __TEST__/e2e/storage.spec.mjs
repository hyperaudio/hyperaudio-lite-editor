// Storage picker regression net (#410): saved projects are referenced by KEY
// STRING, not by storage.key(i) position — positional indices shift whenever
// any other module writes a key (the transcribe prefs do so on every toggle),
// which loaded the wrong entry or threw. Also: corrupted entries must not kill
// the click handler, and filenames must render as text, not markup.
import { test, expect } from '@playwright/test';

const seed = (page) => page.evaluate(() => {
  localStorage.clear();
  const entry = (text) => JSON.stringify({
    hypertranscript: `<article><section><p><span data-m="0" data-d="500">${text} </span></p></section></article>`,
    video: 'https://example.com/a.mp3',
    summary: 's', topics: [],
  });
  localStorage.setItem('alpha.hyperaudio', entry('ALPHA'));
  localStorage.setItem('beta.hyperaudio', entry('BETA'));
  loadLocalStorageOptions();
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('clicking a file loads that file even after other keys shift the order (#410)', async ({ page }) => {
  await seed(page);
  // shift the key landscape AFTER the list rendered — this is what the
  // prefs/export modules do at arbitrary times
  await page.evaluate(() => {
    localStorage.setItem('aaa-unrelated', 'x');
    localStorage.removeItem('aaa-unrelated');
    localStorage.setItem('hyperaudioTranscribePrefs', '{"serviceMode":"local"}');
  });
  await page.evaluate(() => {
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'beta').click();
  });
  await page.waitForTimeout(300);
  const loaded = await page.evaluate(() => document.querySelector('#hypertranscript').textContent);
  expect(loaded).toContain('BETA');
  expect(loaded).not.toContain('ALPHA');
});

test('a corrupted entry does not throw and the picker keeps working (#410)', async ({ page }) => {
  await seed(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluate(() => {
    localStorage.setItem('broken.hyperaudio', '{not json');
    loadLocalStorageOptions();
  });
  await page.evaluate(() => {
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'broken').click();
  });
  await page.evaluate(() => {
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'alpha').click();
  });
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.querySelector('#hypertranscript').textContent)).toContain('ALPHA');
});

test('a filename containing markup renders as text (#410)', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    localStorage.setItem('<img src=x onerror=window.__xss=1>.hyperaudio', localStorage.getItem('alpha.hyperaudio'));
    loadLocalStorageOptions();
  });
  const r = await page.evaluate(() => ({
    xss: window.__xss === 1,
    itemTexts: [...document.querySelectorAll('.file-item')].map((a) => a.textContent),
    imgInPicker: document.querySelector('#file-picker img') !== null,
  }));
  expect(r.xss).toBe(false);
  expect(r.imgInPicker).toBe(false);
  expect(r.itemTexts).toContain('<img src=x onerror=window.__xss=1>');
});

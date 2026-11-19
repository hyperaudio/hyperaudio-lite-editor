// #811 — the local Whisper tab lists all 99 of Whisper's languages, grouped
// by its published FLEURS error rates into Good and Lower accuracy, and a note
// shows under the menu when a Lower accuracy language is chosen, including
// one remembered from an earlier visit.
import { test, expect } from '@playwright/test';

const openWhisperTab = async (page) => {
  await page.click('#new-transcription-btn');
  await page.evaluate(() => {
    document.getElementById('service-local').checked = true;
    const tab = document.querySelector('input[name="local_tabs"][aria-label="Whisper"]');
    if (tab) tab.checked = true;
  });
};

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('every Whisper language is listed once, English and Auto-detect first, then the two groups (#811)', async ({ page }) => {
  const menu = await page.evaluate(() => {
    const select = document.getElementById('whisper-language');
    const top = [...select.children].filter((el) => el.tagName === 'OPTION').map((o) => o.value);
    const groups = [...select.querySelectorAll('optgroup')].map((g) => ({
      label: g.label,
      experimental: g.hasAttribute('data-low-accuracy'),
      names: [...g.querySelectorAll('option')].map((o) => o.textContent),
      values: [...g.querySelectorAll('option')].map((o) => o.value),
    }));
    return { top, groups, selected: select.value };
  });
  expect(menu.top).toEqual(['en', '']);
  expect(menu.selected).toBe('en');
  expect(menu.groups.map((g) => [g.label, g.experimental])).toEqual([['Good', false], ['Lower accuracy – expect heavy correction', true]]);
  const all = menu.groups.flatMap((g) => g.values);
  expect(all.length + 1).toBe(99);
  expect(new Set(all).size).toBe(all.length);
  // each group is alphabetical
  menu.groups.forEach((g) => expect(g.names).toEqual([...g.names].sort((a, b) => a.localeCompare(b))));
  const group = (code) => menu.groups.find((g) => g.values.includes(code)).label;
  // the languages from the issue are all there
  ['te', 'ta', 'bn', 'mr', 'kn', 'ml', 'ur', 'gu', 'pa'].forEach((c) => expect(all).toContain(c));
  expect(group('fr')).toBe('Good');
  expect(group('ta')).toBe('Good');
  expect(group('te')).toMatch(/^Lower accuracy/);
  expect(group('he')).toMatch(/^Lower accuracy/);
});

test('a Lower accuracy language shows the note, a Good one does not (#811)', async ({ page }) => {
  await openWhisperTab(page);
  const note = page.locator('#whisper-language-note');
  await expect(note).toBeHidden();
  await page.selectOption('#whisper-language', 'te');
  await expect(note).toBeVisible();
  await expect(note.locator('a')).toHaveAttribute('href', /docs\/adding-an-stt-engine\.md$/);
  await page.selectOption('#whisper-language', 'fr');
  await expect(note).toBeHidden();
  await page.selectOption('#whisper-language', '');
  await expect(note).toBeHidden();
});

test('a remembered Lower accuracy language shows the note when the dialog opens (#811)', async ({ page }) => {
  // the remembered choice comes back without a change event, as transcribe-prefs.js restores it
  await page.evaluate(() => { document.getElementById('whisper-language').value = 'gu'; });
  await openWhisperTab(page);
  await expect(page.locator('#whisper-language-note')).toBeVisible();
});

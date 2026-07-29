// Storage picker regression net (#410) + the Recents storage model (#434):
// saved projects are referenced by KEY STRING, not by storage.key(i) position
// — positional indices shift whenever any other module writes a key (the
// transcribe prefs do so on every toggle), which loaded the wrong entry or
// threw. Corrupted entries must not kill the click handler, and filenames must
// render as text, not markup. Since #434, entries are keyed by stable ID with
// the display name in meta (legacy name-keyed entries migrate on first list
// render), rows can be renamed inline and deleted (two-step), and the list
// orders by last-updated.
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

test('legacy name-keyed entries migrate to stable ID keys on first list render (#434)', async ({ page }) => {
  await seed(page);
  const r = await page.evaluate(() => ({
    legacyKeys: Object.keys(localStorage).filter((k) => k.endsWith('.hyperaudio')),
    docKeys: Object.keys(localStorage).filter((k) => k.startsWith('hyperaudio:doc:')),
    names: [...document.querySelectorAll('.file-item')].map((a) => a.textContent).sort(),
  }));
  expect(r.legacyKeys).toEqual([]);
  expect(r.docKeys.length).toBe(2);
  expect(r.names).toEqual(['alpha', 'beta']);
});

test('rows order by last edit, falling back to creation date; migrated entries carry a date (#434)', async ({ page }) => {
  await seed(page); // alpha + beta migrate with created = migration time
  await page.evaluate(() => {
    const entry = (name, meta) => JSON.stringify({
      hypertranscript: '<article><section><p><span data-m="0" data-d="1">x </span></p></section></article>',
      video: 'https://example.com/a.mp3', summary: 's', topics: [],
      meta: Object.assign({ name }, meta),
    });
    const now = Date.now();
    localStorage.setItem('hyperaudio:doc:t1', entry('edited-recently', { updated: now + 100000 }));
    localStorage.setItem('hyperaudio:doc:t2', entry('created-recently', { created: now + 50000 })); // never edited
    loadLocalStorageOptions();
  });
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('.file-item')].map((a) => a.textContent));
  // migrated alpha/beta share a creation stamp → tie broken alphabetically
  expect(names).toEqual(['edited-recently', 'created-recently', 'alpha', 'beta']);
});

test('rename via the row action edits the name in place; the key is untouched (#434)', async ({ page }) => {
  await seed(page);
  const keysBefore = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hyperaudio:doc:')).sort());
  const row = page.locator('.recents-row', { has: page.locator('.file-item', { hasText: 'alpha' }) });
  await row.hover();
  await row.locator('.recents-rename').click();
  const input = page.locator('.recents-rename-input');
  await input.fill('interview notes');
  await input.press('Enter');
  await expect(page.locator('.file-item', { hasText: 'interview notes' })).toHaveCount(1);
  const after = await page.evaluate(() => ({
    keys: Object.keys(localStorage).filter((k) => k.startsWith('hyperaudio:doc:')).sort(),
    names: Object.keys(localStorage).filter((k) => k.startsWith('hyperaudio:doc:'))
      .map((k) => JSON.parse(localStorage.getItem(k)).meta.name).sort(),
  }));
  expect(after.keys).toEqual(keysBefore);
  expect(after.names).toEqual(['beta', 'interview notes']);
});

test('escape cancels a rename without changing the name (#434)', async ({ page }) => {
  await seed(page);
  const row = page.locator('.recents-row', { has: page.locator('.file-item', { hasText: 'alpha' }) });
  await row.hover();
  await row.locator('.recents-rename').click();
  const input = page.locator('.recents-rename-input');
  await input.fill('should-not-stick');
  await input.press('Escape');
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('.file-item')].map((a) => a.textContent).sort());
  expect(names).toEqual(['alpha', 'beta']);
});

test('delete is two-step and removes the entry (#434)', async ({ page }) => {
  await seed(page);
  const row = page.locator('.recents-row', { has: page.locator('.file-item', { hasText: 'alpha' }) });
  await row.hover();
  const del = row.locator('.recents-delete');
  await del.click();
  // armed, not deleted
  await expect(del).toHaveText('Delete?');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hyperaudio:doc:')).length)).toBe(2);
  await del.click();
  await expect(page.locator('.file-item', { hasText: 'alpha' })).toHaveCount(0);
  await expect(page.locator('.file-item', { hasText: 'beta' })).toHaveCount(1);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hyperaudio:doc:')).length)).toBe(1);
});

test('clicking a row loads it and marks it active; the highlight survives a re-render (#434)', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'beta').click();
  });
  await page.waitForTimeout(300);
  await expect(page.locator('.file-item.active')).toHaveText('beta');
  await page.evaluate(() => loadLocalStorageOptions());
  await expect(page.locator('.file-item.active')).toHaveText('beta');
});

test('a new transcription auto-saves to Recents named after its media; repeats get a suffix (#435)', async ({ page }) => {
  await seed(page);
  const transcribe = () => page.evaluate(() => {
    document.querySelector('#hyperplayer').src = 'https://example.com/media/clip.mp4';
    document.querySelector('#hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">FRESH </span></p></section></article>';
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  });
  await transcribe();
  await expect(page.locator('.file-item', { hasText: 'clip.mp4' })).toHaveCount(1);
  // the new entry is active and sits first (newest updated)
  await expect(page.locator('.file-item.active')).toHaveText('clip.mp4');
  expect(await page.evaluate(() => document.querySelector('.file-item').textContent)).toBe('clip.mp4');
  // a second transcription of the same media coexists rather than overwriting
  await transcribe();
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('.file-item')].map((a) => a.textContent));
  expect(names).toContain('clip.mp4');
  expect(names).toContain('clip.mp4 (2)');
});

test('the autosave disclosure shows once ever, is info-toned, and dismisses (#435)', async ({ page }) => {
  await seed(page); // clears localStorage, so the flag is unset
  const transcribe = () => page.evaluate(() => {
    document.querySelector('#hyperplayer').src = 'https://example.com/media/clip.mp4';
    document.querySelector('#hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">X </span></p></section></article>';
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  });
  await transcribe();
  const notice = page.locator('#recents-notice');
  await expect(notice).toHaveClass(/notice-info/);
  await expect(notice).toContainText('on this device only');
  await notice.locator('.recents-notice-dismiss').click();
  await expect(notice).toHaveCount(0);
  await transcribe();
  await expect(notice).toHaveCount(0); // never again
});

test('edits autosave (debounced) to the active entry and bump its updated stamp (#435)', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'beta').click();
  });
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith('hyperaudio:doc:') && JSON.parse(localStorage.getItem(k)).meta.name === 'beta');
    return { key, updated: JSON.parse(localStorage.getItem(key)).meta.updated || 0 };
  });
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]');
    span.textContent = 'EDITED ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(2600); // past the 2s debounce
  const after = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), before.key);
  expect(after.hypertranscript).toContain('EDITED');
  expect(after.meta.name).toBe('beta');           // autosave keeps the name
  expect(after.meta.updated).toBeGreaterThan(before.updated);
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

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
  await row.locator('.recents-kebab').click();
  await page.locator('#recents-menu .recents-menu-rename').click();
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
  await row.locator('.recents-kebab').click();
  await page.locator('#recents-menu .recents-menu-rename').click();
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
  await row.locator('.recents-kebab').click();
  const del = page.locator('#recents-menu .recents-menu-delete');
  await del.click();
  // armed, not deleted
  await expect(del).toHaveText('Delete?');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hyperaudio:doc:')).length)).toBe(2);
  await del.click();
  await expect(page.locator('.file-item', { hasText: 'alpha' })).toHaveCount(0);
  await expect(page.locator('.file-item', { hasText: 'beta' })).toHaveCount(1);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hyperaudio:doc:')).length)).toBe(1);
});

test('deleting the loaded entry offers Restore; restoring re-saves the on-screen doc (#434)', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'beta').click();
  });
  await page.waitForTimeout(300);
  const row = page.locator('.recents-row', { has: page.locator('.file-item', { hasText: 'beta' }) });
  await row.hover();
  await row.locator('.recents-kebab').click();
  const del = page.locator('#recents-menu .recents-menu-delete');
  await del.click();
  await del.click(); // confirm
  await expect(page.locator('.file-item', { hasText: 'beta' })).toHaveCount(0);
  const notice = page.locator('#recents-notice');
  await expect(notice).toContainText('no longer being saved');
  // the transcript is still on screen
  expect(await page.evaluate(() => document.querySelector('#hypertranscript').textContent)).toContain('BETA');
  await notice.locator('.recents-notice-action').click();
  await expect(notice).toHaveCount(0);
  await expect(page.locator('.file-item', { hasText: 'beta' })).toHaveCount(1);
  await expect(page.locator('.file-item.active')).toHaveText('beta');
  const restored = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith('hyperaudio:doc:') && JSON.parse(localStorage.getItem(k)).meta.name === 'beta');
    return JSON.parse(localStorage.getItem(key));
  });
  expect(restored.hypertranscript).toContain('BETA');
});

test('a pending Restore is withdrawn when the screen holds a different document (#434)', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'beta').click();
  });
  await page.waitForTimeout(300);
  const row = page.locator('.recents-row', { has: page.locator('.file-item', { hasText: 'beta' }) });
  await row.hover();
  await row.locator('.recents-kebab').click();
  const del = page.locator('#recents-menu .recents-menu-delete');
  await del.click();
  await del.click();
  await expect(page.locator('#recents-notice')).toContainText('no longer being saved');
  // loading another entry invalidates restore-from-screen
  await page.evaluate(() => {
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'alpha').click();
  });
  await expect(page.locator('#recents-notice')).toHaveCount(0);
});

test('a very long name truncates with ellipsis instead of pushing the actions off-screen (#436)', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    localStorage.setItem('hyperaudio:doc:long', JSON.stringify({
      hypertranscript: '<article><section><p><span data-m="0" data-d="1">x </span></p></section></article>',
      video: 'https://example.com/a.mp3', summary: '', topics: [],
      meta: { name: 'A_really_long_interview_' + 'x'.repeat(80) + '.mp4', updated: 9999 },
    }));
    loadLocalStorageOptions();
  });
  const r = await page.evaluate(() => {
    const picker = document.querySelector('#file-picker').getBoundingClientRect();
    const name = [...document.querySelectorAll('.file-item')]
      .find((a) => a.textContent.startsWith('A_really_long_interview_'));
    const actions = name.closest('.recents-row').querySelector('.recents-actions').getBoundingClientRect();
    return {
      pickerVisible: picker.width > 0,
      actionsInside: actions.right <= picker.right + 1,
      truncated: name.scrollWidth > name.clientWidth,
    };
  });
  expect(r.pickerVisible).toBe(true);
  expect(r.actionsInside).toBe(true);
  expect(r.truncated).toBe(true);
});

test('the row Duplicate action copies an entry with a suffixed name, original untouched (#436)', async ({ page }) => {
  await seed(page);
  const row = page.locator('.recents-row', { has: page.locator('.file-item', { hasText: 'beta' }) });
  await row.hover();
  await row.locator('.recents-kebab').click();
  await page.locator('#recents-menu .recents-menu-duplicate').click();
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('.file-item')].map((a) => a.textContent));
  expect(names[0]).toBe('beta (2)'); // fresh stamps put the copy on top
  expect(names).toContain('beta');
  expect(names).toContain('alpha');
});

test('editing a never-saved document (the demo) auto-creates its Recents entry (#436)', async ({ page }) => {
  await page.evaluate(() => { localStorage.clear(); loadLocalStorageOptions(); });
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]');
    span.textContent = 'DEMO-EDIT ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(2600);
  const saved = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('hyperaudio:doc:'));
    return { count: keys.length, entry: keys.length ? JSON.parse(localStorage.getItem(keys[0])) : null };
  });
  expect(saved.count).toBe(1);
  expect(saved.entry.hypertranscript).toContain('DEMO-EDIT');
});

test('a pending Restore suppresses auto-create; dismissing it re-enables (#436)', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'beta').click();
  });
  await page.waitForTimeout(300);
  const row = page.locator('.recents-row', { has: page.locator('.file-item', { hasText: 'beta' }) });
  await row.hover();
  await row.locator('.recents-kebab').click();
  const del = page.locator('#recents-menu .recents-menu-delete');
  await del.click();
  await del.click(); // confirm — Restore offer now pending
  const edit = () => page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]');
    span.textContent = 'EDIT-AFTER-DELETE ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await edit();
  await page.waitForTimeout(2600);
  // deleted on purpose: the edit must NOT silently recreate the entry
  expect(await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('hyperaudio:doc:')).length)).toBe(1);
  await page.locator('#recents-notice .recents-notice-dismiss').click();
  await edit();
  await page.waitForTimeout(2600);
  // offer declined: the doc is now just an unsaved document — edits re-enter Recents
  expect(await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('hyperaudio:doc:')).length)).toBe(2);
});

test('starring pins an entry into a Starred group; unstarring removes the labels (#440)', async ({ page }) => {
  await seed(page);
  const row = page.locator('.recents-row', { has: page.locator('.file-item', { hasText: 'beta' }) });
  await row.hover();
  await row.locator('.recents-kebab').click();
  await expect(page.locator('#recents-menu .recents-menu-star')).toHaveText('Star');
  await page.locator('#recents-menu .recents-menu-star').click();

  // grouped: Starred heading, beta, Recents heading, alpha — and the panel's
  // static "Recents" h2 hides while the in-list h2 headings are shown
  await expect(page.locator('.recents-group-heading h2')).toHaveText(['Starred', 'Recents']);
  await expect(page.locator('#recents-title')).toBeHidden();
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('#file-picker li')].map((li) => li.textContent.trim()));
  expect(order[0]).toBe('Starred');
  expect(order[1]).toContain('beta');
  expect(order[2]).toBe('Recents');
  expect(order[3]).toContain('alpha');

  // autosave-style re-save must carry the star through the meta rebuild
  await page.evaluate(() => {
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'beta').click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]');
    span.textContent = 'STAR-EDIT ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(2600);
  const starredAfterSave = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith('hyperaudio:doc:') && JSON.parse(localStorage.getItem(k)).meta.name === 'beta');
    return JSON.parse(localStorage.getItem(key)).meta.starred;
  });
  expect(starredAfterSave).toBe(true);

  // unstar → flat list again, no labels
  const starredRow = page.locator('.recents-row', { has: page.locator('.file-item', { hasText: 'beta' }) });
  await starredRow.hover();
  await starredRow.locator('.recents-kebab').click();
  await expect(page.locator('#recents-menu .recents-menu-star')).toHaveText('Unstar');
  await page.locator('#recents-menu .recents-menu-star').click();
  await expect(page.locator('.recents-group-heading')).toHaveCount(0);
  await expect(page.locator('#recents-title')).toBeVisible(); // default look restored
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

test('auto-add never captures the previous document\'s captions/summary/topics (#435)', async ({ page }) => {
  await seed(page);
  const saved = await page.evaluate(() => {
    // the state the engines leave at hyperaudioInit time: the caption track,
    // summary, and topics still belong to the PREVIOUS document (the intro
    // demo on a fresh session) — regeneration happens after the event
    document.getElementById('hyperplayer-vtt').src =
      'data:text/vtt;charset=utf-8,' + encodeURIComponent('WEBVTT\n\n00:00.000 --> 00:01.000\nSTALE DEMO CUE');
    document.getElementById('summary').innerHTML = 'stale demo summary';
    document.getElementById('topics').innerHTML = 'stale, demo, topics';
    document.querySelector('#hyperplayer').src = 'https://example.com/media/clip.mp4';
    document.querySelector('#hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">FRESH </span></p></section></article>';
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith('hyperaudio:doc:') && JSON.parse(localStorage.getItem(k)).meta.name === 'clip.mp4');
    return JSON.parse(localStorage.getItem(key));
  });
  expect(saved.captions).toBeUndefined();   // load regenerates from the transcript instead
  expect(saved.summary).toBe('');
  expect(saved.topics).toEqual([]);
  expect(saved.hypertranscript).toContain('FRESH');
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

test('a Recents load restores the media reference for the interactive export (#426)', async ({ page }) => {
  await seed(page);
  // a local-media doc: video is the indexeddb: marker, the blob is cached
  // under meta.mediaKey, and meta.mediaRef holds the original filename
  await page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open('hyperaudioMedia', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('media');
    open.onsuccess = () => {
      const tx = open.result.transaction('media', 'readwrite');
      tx.objectStore('media').put('data:audio/mp3;base64,AAAA', 'm-key');
      tx.oncomplete = () => resolve();
    };
  }));
  await page.evaluate(() => {
    localStorage.setItem('hyperaudio:doc:localdoc', JSON.stringify({
      hypertranscript: '<article><section><p><span data-m="0" data-d="500">LOCAL </span></p></section></article>',
      video: 'indexeddb:', summary: '', topics: [],
      meta: { name: 'my doc', mediaKey: 'm-key', mediaRef: 'clip.mp4', updated: 5000 },
    }));
    loadLocalStorageOptions();
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'my doc').click();
  });
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const modal = document.getElementById('interactive-export-modal');
    modal.checked = true;
    modal.dispatchEvent(new Event('change'));
    return {
      stamped: document.getElementById('hyperplayer').dataset.mediaRef,
      dialogValue: document.getElementById('interactive-media-filename').value,
      playerSrc: document.getElementById('hyperplayer').src,
    };
  });
  expect(r.stamped).toBe('clip.mp4');
  expect(r.dialogValue).toBe('clip.mp4');
  expect(r.playerSrc.startsWith('data:')).toBe(true); // the cached media loaded

  // autosave must carry the reference through the meta rebuild
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]');
    span.textContent = 'LOCAL-EDIT ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(2600);
  expect(await page.evaluate(() =>
    JSON.parse(localStorage.getItem('hyperaudio:doc:localdoc')).meta.mediaRef)).toBe('clip.mp4');
});

test('a pre-mediaRef entry whose name is still the media filename backfills the reference (#426)', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    localStorage.setItem('hyperaudio:doc:old', JSON.stringify({
      hypertranscript: '<article><section><p><span data-m="0" data-d="500">OLD </span></p></section></article>',
      video: 'indexeddb:', summary: '', topics: [],
      meta: { name: 'clapper-march-13.mp4', mediaKey: 'nope', updated: 5000 }, // no mediaRef
    }));
    loadLocalStorageOptions();
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'clapper-march-13.mp4').click();
  });
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const modal = document.getElementById('interactive-export-modal');
    modal.checked = true;
    modal.dispatchEvent(new Event('change'));
    return document.getElementById('interactive-media-filename').value;
  });
  expect(r).toBe('clapper-march-13.mp4');
});

test('an entry predating mediaRef clears the stamp instead of offering stale media (#426)', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    document.getElementById('hyperplayer').dataset.mediaRef = 'stale-previous.mp4';
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'alpha').click();
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.getElementById('hyperplayer').dataset.mediaRef)).toBeUndefined();
});

test('switching docs flushes the pending autosave — the last edits are not dropped', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'beta').click();
  });
  await page.waitForTimeout(300);
  // edit beta, then switch to alpha IMMEDIATELY — inside the 2s debounce
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]');
    span.textContent = 'FLUSH-ME ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'alpha').click();
  });
  await page.waitForTimeout(300);
  // the edit landed in beta's entry despite the debounce not having elapsed
  const saved = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith('hyperaudio:doc:') && JSON.parse(localStorage.getItem(k)).meta.name === 'beta');
    return JSON.parse(localStorage.getItem(key)).hypertranscript;
  });
  expect(saved).toContain('FLUSH-ME');
  // and switching back shows it
  await page.evaluate(() => {
    [...document.querySelectorAll('.file-item')].find((a) => a.textContent === 'beta').click();
  });
  await page.waitForTimeout(300);
  await expect(page.locator('#hypertranscript')).toContainText('FLUSH-ME');
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

// #757, the repair. Before 1.3.43 a transcript imported without media was
// saved as a link to whatever the player held: the intro audio, or the page's
// own address. Every boot now looks the index over for links to either and
// sets those projects to no media, in their saved state, their draft and the
// index. The intro project, which links to the intro audio by right, is told
// apart by its transcript. A real link is left alone.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { ladderWav } from './helpers.mjs';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js');

// the intro audio served here, so the intro project plays whatever the
// network is doing, and no offer to re-attach media stands in the way
test.beforeEach(async ({ page }) => {
  await page.route('**/HLEintroAudio.mp3', (route) => route.fulfill({ body: ladderWav(2), contentType: 'audio/wav' }));
});

const REAL_URL = 'https://media.example.com/talks/keynote.mp3';

function projectJson(title, url, words) {
  const state = {
    generatorVersion: 'e2e',
    created: '2026-07-10T09:00:00Z',
    modified: '2026-07-10T11:30:00Z',
    media: { kind: 'link', path: null, url, filename: url.split('/').pop(), mimeType: '', durationSeconds: 64, sizeBytes: 0 },
    options: {
      gapRemoval: { enabled: false, thresholdMs: 500, bufferMs: 100 },
      updateCaptionsFromTranscript: true,
      view: { showSpeakers: true, showTimecodes: false },
    },
    texts: { title, language: 'it', summary: '', topics: [] },
    provenance: null,
    hasOriginal: false,
    transcript: {
      words: (words || ['Benvenuti', 'a']).map((text, i) => ({ start: 0.32 + i, end: 0.84 + i, text })),
      paragraphs: [{ speaker: null, start: 0.32, end: 0.84 + (words || ['', '']).length - 1 }],
    },
  };
  return save.serializeProjectJson(save.buildProjectJson(state));
}
const htmlOf = (words) => '<article><section><p>' + (words || ['Benvenuti', 'a']).map((text, i) =>
  `<span data-m="${320 + i * 1000}" data-d="520">${text} </span>`).join('') + '</p></section></article>';
const HTML = htmlOf();

// a project written the way the old editor left it: its files and its index
// entry. A draft is written before the save when the project says so (an
// older draft beside a newer save, #659), otherwise after it.
const seed = (page, projects) => page.evaluate(async (projects) => {
  const root = await navigator.storage.getDirectory();
  const work = await root.getDirectoryHandle('work', { create: true });
  const write = async (dir, name, text) => { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(text); await w.close(); };
  const pause = () => new Promise((r) => setTimeout(r, 30));
  const libFile = await (await root.getFileHandle('library.json')).getFile();
  const lib = JSON.parse(await libFile.text());
  for (const p of projects) {
    const dir = await work.getDirectoryHandle(p.id, { create: true });
    const draft = p.draft ? JSON.stringify({ json: p.draftJson || p.json, html: p.draftHtml || p.html, captionsVtt: null }) : null;
    if (draft !== null && p.draftFirst) { await write(dir, 'draft.json', draft); await pause(); }
    await write(dir, 'saved.json', JSON.stringify({ json: p.json, html: p.html, captionsVtt: null }));
    if (draft !== null && !p.draftFirst) { await pause(); await write(dir, 'draft.json', draft); }
    lib.projects.push({ id: p.id, name: p.name, starred: false, createdAt: 1783000000000, modifiedAt: 1783000000000, lastDraftAt: p.draft ? 1783000000000 : 0, lastSavedAt: 1783000000000, lastActiveAt: 0,
      media: { kind: 'link', filename: p.url.split('/').pop(), durationSeconds: 64, hasVideo: false, url: p.url }, docDurationSeconds: 1.5, summary: '', topics: [] });
  }
  await write(root, 'library.json', JSON.stringify(lib));
}, projects);

// what the index and each project's files say about its media; null while
// the repair is mid-write, so a poll simply asks again
const mediaOf = (page) => page.evaluate(async () => {
  try {
    const root = await navigator.storage.getDirectory();
    const work = await root.getDirectoryHandle('work');
    const out = {};
    for (const e of (await window.HyperaudioSave.library.list())) {
      const dir = await work.getDirectoryHandle(e.id);
      const read = async (name) => { try { const t = await (await (await dir.getFileHandle(name)).getFile()).text(); return JSON.parse(JSON.parse(t).json).media; } catch (err) { return null; } };
      const saved = await read('saved.json');
      const draft = await read('draft.json');
      out[e.name] = { index: e.media.kind, indexUrl: e.media.url, saved: saved && saved.kind, draft: draft && draft.kind };
    }
    return out;
  } catch (e) { return null; }
});

test('projects linked to the intro audio or the page itself by mistake are set to no media at boot', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(async () => (await window.HyperaudioSave.library.list()).length)).toBe(1);
  const introUrl = await page.evaluate(() => document.getElementById('hyperplayer').getAttribute('src'));
  expect(introUrl).toContain('HLEintroAudio');
  const pageUrl = 'http://localhost:4173/index.html';

  await seed(page, [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Notes', url: introUrl, json: projectJson('Notes', introUrl), html: HTML, draft: true },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Captions', url: pageUrl, json: projectJson('Captions', pageUrl), html: HTML, draft: false },
    { id: 'aaaaaaaa-0000-4000-8000-000000000003', name: 'Keynote', url: REAL_URL, json: projectJson('Keynote', REAL_URL), html: HTML, draft: false },
  ]);
  // before the boot that repairs them, the index says link for all four
  expect((await mediaOf(page)).Notes).toEqual({ index: 'link', indexUrl: introUrl, saved: 'link', draft: 'link' });

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(async () => ((await mediaOf(page)) || {}).Notes).toEqual({ index: 'none', indexUrl: '', saved: 'none', draft: 'none' });
  const after = await mediaOf(page);
  expect(after.Captions).toEqual({ index: 'none', indexUrl: '', saved: 'none', draft: null });
  expect(after.Keynote).toEqual({ index: 'link', indexUrl: REAL_URL, saved: 'link', draft: null });
  // the intro project keeps its link: it is the intro
  expect(after['How to use the Editor']).toMatchObject({ index: 'link', indexUrl: introUrl, saved: 'link' });

  // a repaired project opens with nothing on the player, and Retranscribe says why
  await page.locator('#file-picker .file-item[data-id]', { hasText: 'Notes' }).click();
  await expect(page.locator('#file-picker .file-item.active')).toHaveText('Notes');
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  expect(await page.evaluate(() => document.getElementById('hyperplayer').getAttribute('src'))).toBe(null);
  const item = page.locator('#file-picker .file-item', { hasText: 'Notes' });
  await item.hover();
  await item.locator('..').locator('.recents-kebab').click();
  await expect(page.locator('#recents-menu .recents-menu-transcribe')).toBeDisabled();

  // and a second boot finds nothing more to do
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(async () => ((await mediaOf(page)) || {}).Notes).toEqual({ index: 'none', indexUrl: '', saved: 'none', draft: 'none' });
  expect((await mediaOf(page))['How to use the Editor']).toMatchObject({ index: 'link', indexUrl: introUrl });
});

test('an older draft beside a newer save stays the older file, so the project still opens on its save', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(async () => (await window.HyperaudioSave.library.list()).length)).toBe(1);
  const pageUrl = 'http://localhost:4173/index.html';
  await seed(page, [{
    id: 'aaaaaaaa-0000-4000-8000-000000000004', name: 'Stale', url: pageUrl,
    json: projectJson('Stale', pageUrl, ['Saved', 'text']), html: htmlOf(['Saved', 'text']),
    draft: true, draftFirst: true, draftJson: projectJson('Stale', pageUrl, ['Old', 'draft']), draftHtml: htmlOf(['Old', 'draft']),
  }]);
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  // the stale draft is dropped rather than rewritten, which would have made it the newer file
  await expect.poll(async () => ((await mediaOf(page)) || {}).Stale).toEqual({ index: 'none', indexUrl: '', saved: 'none', draft: null });
  await page.locator('#file-picker .file-item[data-id]', { hasText: 'Stale' }).click();
  await expect(page.locator('#hypertranscript')).toContainText('Saved text');
  await expect(page.locator('#hypertranscript')).not.toContainText('Old draft');
});

test('the intro project keeps its link after its opening words are edited', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(async () => (await window.HyperaudioSave.library.list()).length)).toBe(1);
  const introUrl = await page.evaluate(() => document.getElementById('hyperplayer').getAttribute('src'));
  // the first words rewritten, as an edit, and the edit in the project's draft
  await page.evaluate(() => {
    const words = document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)');
    ['Changed', 'opening', 'words', 'here'].forEach((text, i) => { words[i].textContent = text + ' '; });
    document.getElementById('hypertranscript').dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(async () => (await window.HyperaudioSave.library.list())[0].lastDraftAt)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const id = window.HyperaudioSave.library.currentId();
    try { return (await (await (await (await root.getDirectoryHandle('work')).getDirectoryHandle(id)).getFileHandle('draft.json')).getFile()).text(); } catch (e) { return ''; }
  })).toContain('Changed');
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect(page.locator('#hypertranscript')).toContainText('Changed opening words here');
  expect((await mediaOf(page))['How to use the Editor']).toMatchObject({ index: 'link', indexUrl: introUrl, saved: 'link' });
});

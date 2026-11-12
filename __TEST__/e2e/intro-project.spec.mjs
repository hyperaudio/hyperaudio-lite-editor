// #602 — the intro is a project like any other. It used to be markup that boot
// fell back to: on screen, but with no library entry and no directory, so
// editing it autosaved nowhere and isDirty() answered false. The point of the
// change is that it now behaves like anything else in Recents.
import { test, expect } from '@playwright/test';
import { withoutIntroProject, transcriptHtml } from './helpers.mjs';

const rows = (page) => page.evaluate(async () =>
  (await window.HyperaudioSave.library.list()).map((e) => e.name));

test('first run seeds the intro as a project, named and clean (#602)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  await expect.poll(() => rows(page)).toEqual(['How to use the Editor']);
  const state = await page.evaluate(async () => ({
    current: window.HyperaudioSave.library.currentId() !== null,
    dirty: await window.HyperaudioSave.isDirty(),
  }));
  expect(state.current).toBe(true);  // something owns the screen, unlike the old demo
  expect(state.dirty).toBe(false);   // born clean: seeding is not an edit
});

test('editing the intro persists, as it never did before (#602)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => rows(page)).toEqual(['How to use the Editor']);

  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'PERSISTED ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(2500); // let the autosave land

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(
    () => document.getElementById('hypertranscript').textContent.includes('PERSISTED'),
  )).toBe(true);
});

test('deleting the intro is permanent — it does not return on reload (#602)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => rows(page)).toEqual(['How to use the Editor']);

  await page.evaluate(async () => {
    const lib = window.HyperaudioSave.library;
    await lib.remove(lib.currentId());
  });
  await page.reload();
  await page.waitForSelector('#hypertranscript');

  // seeded ONCE, on a marker — not "whenever the library is empty", which
  // would resurrect it on every reload and make deleting it futile
  await expect.poll(() => rows(page)).toEqual([]);
  await expect(page.locator('#file-picker')).toContainText('No projects yet.');
});

test('a host shipping no intro title gets no intro project (#602)', async ({ page }) => {
  // The seam is the markup, so an embedder with its own index.html decides.
  await withoutIntroProject(page);
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForTimeout(800);

  expect(await rows(page)).toEqual([]);
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(null);
});

test('a host that swaps in its own intro undoes back to that intro, not the markup\'s (#793)', async ({ page }) => {
  // The host replaces the transcript at DOMContentLoaded: after the page's
  // scripts took their first undo baseline from the markup, before the seed.
  await page.addInitScript((html) => {
    document.addEventListener('DOMContentLoaded', () => {
      const t = document.getElementById('hypertranscript');
      if (t !== null) t.innerHTML = html;
    });
  }, transcriptHtml([[0, 500, 0, 'HOSTINTRO'], [600, 500, 0, 'own'], [1200, 500, 0, 'words']]));
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => rows(page)).toEqual(['How to use the Editor']);

  // one edit, then undo: the host's intro comes back, never the markup's
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]');
    span.textContent = 'EDITED ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => window.transcriptHistory.canUndo())).toBe(true);
  await page.evaluate(() => window.transcriptHistory.undo());
  const text = await page.evaluate(() => document.getElementById('hypertranscript').textContent);
  expect(text).toContain('HOSTINTRO');
  expect(text).not.toContain('Hyperaudio');
  // and the means: the seed announced the document, as the open and import paths do
  expect(await page.evaluate(() => window.transcriptLifecycle.auditLog()
    .some((e) => e.type === 'identity' && e.detail.origin === 'intro-seed'))).toBe(true);
});

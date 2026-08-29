// #602 — the intro is a project like any other. It used to be markup that boot
// fell back to: on screen, but with no library entry and no directory, so
// editing it autosaved nowhere and isDirty() answered false. The point of the
// change is that it now behaves like anything else in Recents.
import { test, expect } from '@playwright/test';
import { withoutIntroProject } from './helpers.mjs';

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

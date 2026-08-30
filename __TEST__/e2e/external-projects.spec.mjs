// #604 — a host may know about projects the editor does not (.hyperaudio files
// in a folder the user chose). The panel shows them, plainly not-yet-opened,
// and hands clicks back to the host: the host owns storage, the panel owns
// presentation — the division the poster seam already draws.
import { test, expect } from '@playwright/test';

const panel = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#file-picker .recents-row')].map((li) => ({
    name: li.querySelector('.file-item') ? li.querySelector('.file-item').textContent.trim() : '',
    external: li.classList.contains('recents-row-external'),
  })));

const withHost = (page, body) => page.addInitScript(body);

test('host rows appear, interleaved by date rather than grouped (#604)', async ({ page }) => {
  await withHost(page, () => {
    window.hyperaudioExternalProjects = async () => ([
      { id: 'ext:newest', title: 'newest', modified: 9_000_000_000_000 },
      { id: 'ext:oldest', title: 'oldest', modified: 1 },
    ]);
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  // the intro project sits between them by date: grouping the host's rows
  // together would put the two-list feel back inside one list
  await expect.poll(() => panel(page)).toEqual([
    { name: 'newest', external: true },
    { name: 'How to use the Editor', external: false },
    { name: 'oldest', external: true },
  ]);
});

test('clicking a host row delegates to the host (#604)', async ({ page }) => {
  await withHost(page, () => {
    window.hyperaudioExternalProjects = async () => ([{ id: 'ext:one', title: 'one', modified: 9_000_000_000_000 }]);
    window.__opened = [];
    window.hyperaudioOpenExternalProject = async (id) => { window.__opened.push(id); };
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => panel(page)).toContainEqual({ name: 'one', external: true });

  const before = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await page.click('.recents-row-external .file-item');
  await expect.poll(() => page.evaluate(() => window.__opened)).toEqual(['ext:one']);
  // and the panel did not try to open something it knows nothing about
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(before);
});

test('host rows carry no actions until they are real projects (#604)', async ({ page }) => {
  await withHost(page, () => {
    window.hyperaudioExternalProjects = async () => ([{ id: 'ext:one', title: 'one', modified: 9_000_000_000_000 }]);
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => panel(page)).toContainEqual({ name: 'one', external: true });

  // rename, star and delete would all be lies about something not held here
  expect(await page.locator('.recents-row-external .recents-kebab').count()).toBe(0);
  await expect(page.locator('.recents-row-external .recents-external-badge')).toBeVisible();
});

test('a hook that throws leaves the panel with its own rows (#604)', async ({ page }) => {
  await withHost(page, () => {
    window.hyperaudioExternalProjects = () => { throw new Error('host is broken'); };
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => panel(page)).toEqual([{ name: 'How to use the Editor', external: false }]);
});

test('a hook that hangs does not hold the panel hostage (#604)', async ({ page }) => {
  await withHost(page, () => {
    window.hyperaudioExternalProjects = () => new Promise(() => {}); // never settles
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // no allowance to wait out: the panel never waited in the first place
  await expect.poll(() => panel(page), { timeout: 3000 })
    .toEqual([{ name: 'How to use the Editor', external: false }]);
});

test('a slow host does not delay the panel (#604)', async ({ page }) => {
  // The panel renders on every library write — after each autosave, not just
  // when Recents is opened — so waiting on the host is felt while working.
  // Measured before the rewrite: a 1200ms host delayed the active-row
  // highlight by 1216ms after a switch, leaving the list pointing at the
  // project you had just left.
  await withHost(page, () => {
    window.hyperaudioExternalProjects = () => new Promise((r) => setTimeout(() => r([
      { id: 'ext:slow', title: 'a slow host row', modified: 9_000_000_000_000 },
    ]), 1200));
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  // the editor's own row is there long before the host answers
  await expect.poll(() => panel(page), { timeout: 900 })
    .toEqual([{ name: 'How to use the Editor', external: false }]);
  // and the host's arrives afterwards, without anything having blocked
  await expect.poll(() => panel(page), { timeout: 5000 }).toEqual([
    { name: 'a slow host row', external: true },
    { name: 'How to use the Editor', external: false },
  ]);
});

test('a stable host is not asked forever (#604)', async ({ page }) => {
  // Re-rendering when the answer arrives could re-ask, re-render, re-ask.
  // It settles because a render only repeats when the answer CHANGED.
  await withHost(page, () => {
    window.__calls = 0;
    window.hyperaudioExternalProjects = async () => {
      window.__calls += 1;
      return [{ id: 'ext:stable', title: 'stable', modified: 9_000_000_000_000 }];
    };
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => panel(page)).toContainEqual({ name: 'stable', external: true });

  const settled = await page.evaluate(() => window.__calls);
  await page.waitForTimeout(2000); // idle
  expect(await page.evaluate(() => window.__calls)).toBe(settled);
});

test('a host row colliding with a real project is skipped (#604)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const realId = await page.evaluate(async () => {
    for (let i = 0; i < 50; i += 1) {
      const id = window.HyperaudioSave.library.currentId();
      if (id !== null) return id;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  });
  expect(realId).not.toBeNull();

  // the host is better placed to dedupe, but the panel does not depend on it
  await page.evaluate((id) => {
    window.hyperaudioExternalProjects = async () => ([{ id, title: 'a duplicate', modified: 9_000_000_000_000 }]);
    document.dispatchEvent(new CustomEvent('hyperaudioLibraryChanged'));
  }, realId);

  await expect.poll(() => panel(page)).toEqual([{ name: 'How to use the Editor', external: false }]);
});

test('no hooks, no change (#604)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => panel(page)).toEqual([{ name: 'How to use the Editor', external: false }]);
  expect(await page.locator('.recents-row-external').count()).toBe(0);
});

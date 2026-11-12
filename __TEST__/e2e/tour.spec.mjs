// #718 — a tour of the editor: runs once on first use, after the intro
// project is on screen, and again from Settings ▸ Take the tour. Shown is
// seen, however far it is followed. The automatic first run stands down under
// automation, so the tests that want it pretend not to be one.
import { test, expect } from '@playwright/test';
import { pollPage } from './helpers.mjs';

const notAutomation = (page) => page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
});
const popover = (page) => page.locator('.driver-popover.hyperaudio-tour');
const seen = (page) => page.evaluate(() => window.HyperaudioTour.seen());

async function open(page) {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await pollPage(page, async () => (await window.HyperaudioSave.library.list()).length >= 1);
}

test('the tour runs once on first use, after the intro project is on screen', async ({ page }) => {
  await notAutomation(page);
  await open(page);
  await expect(popover(page)).toBeVisible();
  await expect(popover(page)).toContainText('The transcript');
  expect(await seen(page)).toBe(true); // shown is seen
  // the first card is on the transcript, which is real content by now, and
  // the second on the cut-words button (#796): the editing first, and no
  // dialog opened for either
  const anyDialog = () => page.evaluate(() => document.querySelector('.modal-toggle:checked') !== null);
  expect(await anyDialog()).toBe(false);
  expect(await page.evaluate(() => document.querySelector('.driver-active-element').id)).toBe('hypertranscript');
  await page.locator('.driver-popover-next-btn').click();
  await expect(popover(page)).toContainText('Cut words');
  expect(await page.evaluate(() => document.querySelector('.driver-active-element').id)).toBe('strikethrough');
  expect(await anyDialog()).toBe(false);
  await page.locator('.driver-popover-prev-btn').click();
  await expect(popover(page)).toContainText('The transcript');
  // closed part-way, it does not come back
  await page.locator('.driver-popover-close-btn').click();
  await expect(popover(page)).toHaveCount(0);
  expect(await anyDialog()).toBe(false);
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForTimeout(2500);
  await expect(popover(page)).toHaveCount(0);
});

test('it does not run by itself under automation, and can be taken again from Settings', async ({ page }) => {
  await open(page);
  await page.waitForTimeout(2000);
  await expect(popover(page)).toHaveCount(0);
  expect(await seen(page)).toBe(false);
  // Settings ▸ Take the tour: the dialog closes and the tour runs over the page
  await page.evaluate(() => { document.getElementById('settings-modal').checked = true; });
  await page.locator('#settings-tour').click();
  expect(await page.evaluate(() => document.getElementById('settings-modal').checked)).toBe(false);
  await expect(popover(page)).toBeVisible();
  // every step, through to Done: eight cards in the order people meet things
  // (#796), each on its button, none opening a dialog, a menu or the
  // captions view on the viewer's behalf
  const titles = [];
  const targets = {};
  for (;;) {
    const title = await popover(page).locator('.driver-popover-title').textContent();
    titles.push(title);
    const state = await page.evaluate(() => ({
      dialog: document.querySelector('.modal-toggle:checked') !== null,
      rowMenu: document.getElementById('recents-menu') !== null,
      captionsView: document.getElementById('caption-editor-btn').getAttribute('aria-pressed') === 'true',
      target: document.querySelector('.driver-active-element').id,
    }));
    expect(state, title).toMatchObject({ dialog: false, rowMenu: false, captionsView: false });
    targets[title] = state.target;
    const next = page.locator('.driver-popover-next-btn');
    if ((await next.textContent()).trim() === 'Done') { await next.click(); break; }
    await next.click();
  }
  await expect(popover(page)).toHaveCount(0);
  expect(titles).toEqual(['The transcript', 'Cut words', 'Skip the gaps', 'Transcript and captions', 'Export media', 'Transcribe', 'Recents', 'Settings']);
  expect(targets).toEqual({
    'The transcript': 'hypertranscript',
    'Cut words': 'strikethrough',
    'Skip the gaps': 'remove-gaps-btn',
    'Transcript and captions': 'view-switch',
    'Export media': 'export-media-btn',
    Transcribe: 'new-transcription-btn',
    Recents: 'recents-card',
    Settings: 'settings-btn',
  });
  // back on the transcript, as a clean project, with nothing left open
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();
  expect(await page.evaluate(() => window.HyperaudioSave.isDirty())).toBe(false);
  expect(await page.evaluate(() => document.querySelector('.modal-toggle:checked') === null)).toBe(true);
  expect(await seen(page)).toBe(true);
});

test('at phone width the Recents card goes on the drawer button, and hidden targets are skipped', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.evaluate(() => window.HyperaudioTour.start());
  const targets = [];
  for (;;) {
    targets.push(await page.evaluate(() => {
      const el = document.querySelector('.driver-active-element');
      return el === null ? null : (el.id || el.className);
    }));
    const next = page.locator('.driver-popover-next-btn');
    if ((await next.textContent()).trim() === 'Done') { await next.click(); break; }
    await next.click();
  }
  expect(targets).toContain('sidebar-toggle');
  expect(targets).not.toContain('recents-card');
  expect(targets).not.toContain(null); // no card pointing at nothing
});

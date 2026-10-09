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
  await expect(popover(page)).toContainText('Start with a recording');
  expect(await seen(page)).toBe(true); // shown is seen
  // the first card explains the NEW button with nothing open; the second
  // opens the Transcribe dialog and points at it; the third closes it and
  // points at the transcript, which is real content by now
  const transcribeOpen = () => page.evaluate(() => document.getElementById('transcribe-modal').checked);
  expect(await transcribeOpen()).toBe(false);
  expect(await page.evaluate(() => document.querySelector('.driver-active-element').id)).toBe('new-transcription-btn');
  await page.locator('.driver-popover-next-btn').click();
  await expect(popover(page)).toContainText('Choose an engine');
  expect(await transcribeOpen()).toBe(true);
  expect(await page.evaluate(() => document.querySelector('.driver-active-element').closest('.modal') !== null)).toBe(true);
  await page.locator('.driver-popover-next-btn').click();
  await expect(popover(page)).toContainText('The transcript');
  expect(await transcribeOpen()).toBe(false);
  expect(await page.evaluate(() => document.querySelector('.driver-active-element').id)).toBe('hypertranscript');
  await page.locator('.driver-popover-prev-btn').click();
  await expect(popover(page)).toContainText('Choose an engine');
  expect(await transcribeOpen()).toBe(true);
  // closed part-way, it does not come back, and what it opened is closed with it
  await page.locator('.driver-popover-close-btn').click();
  await expect(popover(page)).toHaveCount(0);
  expect(await transcribeOpen()).toBe(false);
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
  // every step, through to Done; the Export and Settings steps open what
  // they describe, and the Settings card sits on the Take the tour row
  const titles = [];
  const opened = {};
  for (;;) {
    const title = await popover(page).locator('.driver-popover-title').textContent();
    titles.push(title);
    // the export dialog lists its formats after probing the encoders, as on a click
    if (title === 'The export dialog') {
      await expect.poll(() => page.evaluate(() => document.querySelectorAll('#export-format option').length)).toBeGreaterThan(0);
    }
    opened[title] = await page.evaluate(() => ({
      exportModal: document.getElementById('export-modal').checked,
      settings: document.getElementById('settings-modal').checked,
      rowMenu: document.getElementById('recents-menu') !== null,
      captionsView: document.getElementById('caption-editor-btn').getAttribute('aria-pressed') === 'true',
      target: document.querySelector('.driver-active-element').id,
    }));
    const next = page.locator('.driver-popover-next-btn');
    if ((await next.textContent()).trim() === 'Done') { await next.click(); break; }
    await next.click();
  }
  await expect(popover(page)).toHaveCount(0);
  // the button first, with nothing open, then what it opens
  expect(opened['Transcript and captions']).toMatchObject({ captionsView: false });
  expect(opened['The captions view']).toMatchObject({ captionsView: true, target: 'captions-display' });
  expect(opened.Recents).toMatchObject({ rowMenu: false, captionsView: false });
  expect(opened['A project\'s actions']).toMatchObject({ rowMenu: true, target: 'recents-menu' });
  expect(opened['Export media']).toMatchObject({ rowMenu: false });
  expect(opened['Export media']).toMatchObject({ exportModal: false, target: 'export-media-btn' });
  expect(opened['The export dialog']).toMatchObject({ exportModal: true });
  expect(opened.Settings).toMatchObject({ settings: false, target: 'settings-btn' });
  expect(opened['Taking the tour again']).toMatchObject({ settings: true });
  expect(opened.Recents).toMatchObject({ exportModal: false, settings: false });
  expect(await page.evaluate(() => document.getElementById('recents-menu') === null)).toBe(true);
  // back on the transcript, as a clean project
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();
  expect(await page.evaluate(() => window.HyperaudioSave.isDirty())).toBe(false);
  // while it runs, dialogs cut rather than fade; afterwards they fade again
  expect(await page.evaluate(() => document.body.classList.contains('hyperaudio-touring'))).toBe(false);
  expect(await page.evaluate(() => document.querySelector('.modal-toggle:checked') === null)).toBe(true);
  expect(titles).toEqual(['Start with a recording', 'Choose an engine', 'The transcript', 'Strikethrough', 'Transcript and captions', 'The captions view',
    'Recents', 'A project\'s actions', 'Export media', 'The export dialog', 'Settings', 'Taking the tour again']);
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

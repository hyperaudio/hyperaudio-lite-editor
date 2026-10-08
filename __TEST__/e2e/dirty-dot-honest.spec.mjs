// The dirty dot means "differs from the last save". It used to mean "touched
// since the last save": a view switch flipped and flipped back, or a typed
// character deleted again, left the dot on and a draft on disk, although the
// project was exactly its save. Now a draft write that finds the document back
// on its save retires the draft and takes the dot off, as undo already did (#717).
import { test, expect } from '@playwright/test';
import { pollPage } from './helpers.mjs';

const dirty = (page) => page.evaluate(async () => ({
  dot: document.querySelector('#project-save-btn').classList.contains('dirty'),
  lib: await window.HyperaudioSave.isDirty(),
}));

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await pollPage(page, async () => (await window.HyperaudioSave.library.list()).length >= 1);
  expect(await dirty(page)).toEqual({ dot: false, lib: false });
});

test('a view switch flipped and flipped back leaves the project clean', async ({ page }) => {
  await page.click('#show-timecodes', { force: true });
  await expect.poll(async () => (await dirty(page)).dot).toBe(true); // a real change
  await page.click('#show-timecodes', { force: true });
  await expect.poll(async () => dirty(page), { timeout: 5000 }).toEqual({ dot: false, lib: false });
  // and a reload finds no draft to resurrect
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  expect(await dirty(page)).toEqual({ dot: false, lib: false });
});

test('a typed character deleted again leaves the project clean', async ({ page }) => {
  await page.locator('#hypertranscript span[data-m]').nth(3).click();
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  await expect.poll(async () => dirty(page), { timeout: 5000 }).toEqual({ dot: false, lib: false });
});

test('a change that stays keeps the dot on, and the draft with it', async ({ page }) => {
  await page.locator('#hypertranscript span[data-m]').nth(3).click();
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await page.waitForTimeout(2500);
  expect(await dirty(page)).toEqual({ dot: true, lib: true });
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  expect(await dirty(page)).toEqual({ dot: true, lib: true });
});

test('an edit landing while the clean check runs keeps the dot on', async ({ page }) => {
  await page.locator('#hypertranscript span[data-m]').nth(3).click();
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(1400); // the draft write is about to run
  await page.keyboard.type('y');
  await page.waitForTimeout(3000);
  expect(await dirty(page)).toEqual({ dot: true, lib: true });
});

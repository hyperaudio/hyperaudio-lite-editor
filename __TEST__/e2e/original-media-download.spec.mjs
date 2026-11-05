// #752 — the File menu's two words carry a rule now. Download as: files that
// come out as they are. Export: anything built from the project, which is
// where the media render has moved. And a project whose media is in the
// container can give the file back: Download as ▸ Original media, the stored
// bytes under the stored name, with no render. Hidden for a project that
// plays from a link.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { pollPage } from './helpers.mjs';

const FIXTURE = '__TEST__/fixtures/video-640x360.mp4';

const importWithVtt = async (page, testInfo, videoName) => {
  const vtt = testInfo.outputPath('talk.vtt');
  fs.writeFileSync(vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nHello there\n\n00:00:00.500 --> 00:00:01.000\nfrom the video\n');
  const video = testInfo.outputPath(videoName);
  fs.copyFileSync(FIXTURE, video);
  await page.evaluate(() => { document.getElementById('file-import-vtt-dialog').checked = true; });
  await page.setInputFiles('#vtt-file', video);
  await page.setInputFiles('#vtt', vtt);
  await page.click('#file-import-vtt');
  await expect(page.locator('#hypertranscript')).toContainText('Hello there');
  await pollPage(page, async () => {
    const id = window.HyperaudioSave.library.currentId();
    const e = (await window.HyperaudioSave.library.list()).find((p) => p.id === id);
    return !!(e && e.media && e.media.kind === 'original');
  });
};

const openDownloadSubmenu = (page) => page.evaluate(() => {
  const d = document.getElementById('file-download-submenu');
  if (!d.open) d.querySelector('summary').click();
});

const itemHidden = (page) => page.evaluate(() => document.getElementById('download-original-media').closest('li').hidden);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.library.currentId())).not.toBeNull();
});

test('the media render is under Export, the plain downloads under Download as', async ({ page }) => {
  expect(await page.evaluate(() => !!document.querySelector('#file-export-submenu label[for="export-modal"]'))).toBe(true);
  expect(await page.evaluate(() => !!document.querySelector('#file-download-submenu label[for="export-modal"]'))).toBe(false);
  expect(await page.evaluate(() => !!document.querySelector('#file-download-submenu #download-original-media'))).toBe(true);
});

test('a project that plays from a link has no original media to give', async ({ page }) => {
  await openDownloadSubmenu(page);
  await expect.poll(() => itemHidden(page)).toBe(true);
});

test('a project with its media in the container gives the file back, as it is, under its name', async ({ page }, testInfo) => {
  await importWithVtt(page, testInfo, 'town-hall.mp4');
  await openDownloadSubmenu(page);
  await expect.poll(() => itemHidden(page)).toBe(false);
  await expect(page.locator('#download-original-media')).toHaveAttribute('download', 'town-hall.mp4');

  const download = page.waitForEvent('download');
  await page.evaluate(() => document.getElementById('download-original-media').click());
  const got = await download;
  expect(got.suggestedFilename()).toBe('town-hall.mp4');
  const saved = testInfo.outputPath('back.mp4');
  await got.saveAs(saved);
  expect(fs.readFileSync(saved).equals(fs.readFileSync(FIXTURE))).toBe(true);
});

test('back on the link project, the item is hidden again', async ({ page }, testInfo) => {
  await importWithVtt(page, testInfo, 'town-hall.mp4');
  await openDownloadSubmenu(page);
  await expect.poll(() => itemHidden(page)).toBe(false);
  const intro = await page.evaluate(async () => (await window.HyperaudioSave.library.list()).find((p) => p.name !== 'town-hall.mp4').id);
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), intro);
  await expect.poll(() => itemHidden(page)).toBe(true);
});

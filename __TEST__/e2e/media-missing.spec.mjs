// #738 follow-up — a project must never claim media it does not hold. A save
// of the media that fails (a full disk) is said at the time; a project whose
// media file is missing or empty on the next visit says so, plays nothing
// rather than the previous project's media, and offers to take the file back.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { pollPage } from './helpers.mjs';

const importWithVtt = async (page, testInfo, videoName) => {
  const vtt = testInfo.outputPath('talk.vtt');
  fs.writeFileSync(vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nHello there\n\n00:00:00.500 --> 00:00:01.000\nfrom the video\n');
  const video = testInfo.outputPath(videoName);
  fs.copyFileSync('__TEST__/fixtures/video-640x360.mp4', video);
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
  return page.evaluate(() => window.HyperaudioSave.library.currentId());
};
const mediaDir = (page, id) => page.evaluate(async (id) => {
  const root = await navigator.storage.getDirectory();
  const dir = await (await (await root.getDirectoryHandle('work')).getDirectoryHandle(id)).getDirectoryHandle('media');
  const out = [];
  for await (const [name, h] of dir.entries()) out.push(name + ':' + (await h.getFile()).size);
  return out;
}, id);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await pollPage(page, async () => (await window.HyperaudioSave.library.list()).length >= 1);
});

for (const how of ['missing', 'empty']) {
  test(`a project whose media file is ${how} says so on reopening, plays nothing, and takes the file back`, async ({ page }, testInfo) => {
    const id = await importWithVtt(page, testInfo, 'my-talk.mp4');
    await page.evaluate(async ([id, how]) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('work')).getDirectoryHandle(id)).getDirectoryHandle('media');
      if (how === 'missing') await dir.removeEntry('my-talk.mp4');
      else { const w = await (await dir.getFileHandle('my-talk.mp4')).createWritable(); await w.write(new Uint8Array(0)); await w.close(); }
    }, [id, how]);
    // reopen, as after closing the browser
    await page.reload();
    await page.waitForSelector('#hypertranscript [data-m]');
    await expect(page.locator('#hypertranscript')).toContainText('Hello there');
    await expect(page.locator('#project-dialog.modal-open')).toContainText('missing');
    expect(await page.evaluate(() => document.getElementById('hyperplayer').getAttribute('src'))).toBeNull();
    // choose the file again: it plays, and is saved back into the project
    const chooser = page.waitForEvent('filechooser');
    await page.click('#project-dialog-confirm');
    await (await chooser).setFiles(testInfo.outputPath('my-talk.mp4'));
    await expect.poll(() => page.evaluate(() => document.getElementById('hyperplayer').videoWidth)).toBe(640);
    await expect.poll(() => mediaDir(page, id)).toEqual(['my-talk.mp4:19379']);
  });
}

test('a media save that fails is said at the time, and the transcript is still saved', async ({ page }, testInfo) => {
  // a full disk: every write of a media file fails
  await page.evaluate(() => {
    const real = FileSystemWritableFileStream.prototype.write;
    FileSystemWritableFileStream.prototype.write = function (data) {
      if (data instanceof File && /\.mp4$/.test(data.name)) return Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
      return real.call(this, data);
    };
  });
  await importWithVtt(page, testInfo, 'my-talk.mp4');
  await expect(page.locator('#project-dialog.modal-open')).toContainText('could not be saved');
  await expect(page.locator('#project-dialog.modal-open')).toContainText('not enough free space');
});

test('a media file whose name ends in a space is stored under the name it is looked up by', async ({ page }, testInfo) => {
  const id = await importWithVtt(page, testInfo, 'talk .mp4 ');
  await expect.poll(() => mediaDir(page, id)).toEqual(['talk .mp4:19379']);
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(() => document.getElementById('hyperplayer').videoWidth)).toBe(640);
});

test('a project whose media is still being saved is not called missing', async ({ page }, testInfo) => {
  // a large video: the copy into storage takes a couple of seconds
  await page.evaluate(() => {
    const real = FileSystemWritableFileStream.prototype.write;
    FileSystemWritableFileStream.prototype.write = function (data) {
      if (data instanceof File && /\.mp4$/.test(data.name)) return new Promise((r) => setTimeout(r, 5000)).then(() => real.call(this, data));
      return real.call(this, data);
    };
  });
  const introId = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  const vtt = testInfo.outputPath('talk.vtt');
  fs.writeFileSync(vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nHello there\n');
  const video = testInfo.outputPath('slow.mp4');
  fs.copyFileSync('__TEST__/fixtures/video-640x360.mp4', video);
  await page.evaluate(() => { document.getElementById('file-import-vtt-dialog').checked = true; });
  await page.setInputFiles('#vtt-file', video);
  await page.setInputFiles('#vtt', vtt);
  await page.click('#file-import-vtt');
  await expect(page.locator('#hypertranscript')).toContainText('Hello there');
  const bornId = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  // the user starts correcting at once: the edit's draft puts the project in
  // Recents before its media has finished copying
  await page.locator('#hypertranscript span[data-m]').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await pollPage(page, async (id) => (await window.HyperaudioSave.library.list()).some((p) => p.id === id), bornId);
  // away and straight back, while the copy is still going
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), introId);
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), bornId);
  await expect(page.locator('#hypertranscript')).toContainText('Hello there');
  await page.waitForTimeout(300);
  await expect(page.locator('#project-dialog.modal-open')).toHaveCount(0);
});

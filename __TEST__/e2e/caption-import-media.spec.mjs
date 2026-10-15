// A user's workflow: import a local video with its VTT (or SRT), edit, leave
// the project and come back. The importer used to read the video into memory
// before putting it on the player, while the project was created as soon as
// the caption file was read, so with a video large enough to take a moment
// the project was saved with the previous project's media. Coming back, the
// captions were there and the video was not.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { pollPage } from './helpers.mjs';

for (const kind of ['vtt', 'srt']) {
  test(`a local video imported with its ${kind.toUpperCase()} is still the project's media after leaving and coming back`, async ({ page }, testInfo) => {
    await page.goto('/index.html');
    await page.waitForSelector('#hypertranscript [data-m]');
    await pollPage(page, async () => (await window.HyperaudioSave.library.list()).length >= 1);
    const introId = await page.evaluate(() => window.HyperaudioSave.library.currentId());
    // a large video takes a while to read: make any read of it slow
    await page.evaluate(() => {
      const real = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () { return new Promise((r) => setTimeout(r, 1500)).then(() => real.call(this)); };
    });
    const captions = testInfo.outputPath(`talk.${kind}`);
    fs.writeFileSync(captions, kind === 'vtt'
      ? 'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nHello there\n\n00:00:00.500 --> 00:00:01.000\nfrom the video\n'
      : '1\n00:00:00,000 --> 00:00:00,500\nHello there\n\n2\n00:00:00,500 --> 00:00:01,000\nfrom the video\n');
    const video = testInfo.outputPath('my-talk.mp4');
    fs.copyFileSync('__TEST__/fixtures/video-640x360.mp4', video);
    await page.evaluate((k) => { document.getElementById(`file-import-${k}-dialog`).checked = true; }, kind);
    await page.setInputFiles(`#${kind}-file`, video);
    await page.setInputFiles(`#${kind}`, captions);
    await page.click(`#file-import-${kind}`);
    await expect(page.locator('#hypertranscript')).toContainText('Hello there');
    // the new project is saved with the video as its media
    await pollPage(page, async () => {
      const id = window.HyperaudioSave.library.currentId();
      const entry = (await window.HyperaudioSave.library.list()).find((p) => p.id === id);
      return !!(entry && entry.media && entry.media.filename === 'my-talk.mp4');
    });
    const bornId = await page.evaluate(() => window.HyperaudioSave.library.currentId());
    // away, and back
    await page.evaluate((id) => window.HyperaudioSave.library.open(id), introId);
    await expect(page.locator('#hypertranscript')).not.toContainText('Hello there');
    await page.evaluate((id) => window.HyperaudioSave.library.open(id), bornId);
    await expect(page.locator('#hypertranscript')).toContainText('Hello there');
    await expect.poll(() => page.evaluate(() => {
      const p = document.getElementById('hyperplayer');
      return p.src.startsWith('blob:') && p.videoWidth === 640;
    })).toBe(true);
    const entry = await page.evaluate(async (id) => (await window.HyperaudioSave.library.list()).find((p) => p.id === id), bornId);
    expect(entry.media).toMatchObject({ kind: 'original', filename: 'my-talk.mp4' });
  });
}

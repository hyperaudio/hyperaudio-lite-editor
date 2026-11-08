// A host that keeps the media itself can name its own URL for a file the user
// chooses in an import dialog, through window.hyperaudioMediaUrl(file) (#781). The
// project is then a link to the host's copy, not a second copy in the
// editor's storage. No hook, a throw, or an answer off the declared schemes
// leaves the blob URL and the self-contained project as before.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { pollPage } from './helpers.mjs';

const FIXTURE = '__TEST__/fixtures/video-640x360.mp4';

const importVtt = async (page, testInfo, name) => {
  const vtt = testInfo.outputPath(name + '.vtt');
  fs.writeFileSync(vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nHello there\n\n00:00:00.500 --> 00:00:01.000\nfrom the video\n');
  const video = testInfo.outputPath(name + '.mp4');
  fs.copyFileSync(FIXTURE, video);
  await page.evaluate(() => { document.getElementById('file-import-vtt-dialog').checked = true; });
  await page.setInputFiles('#vtt-file', video);
  await page.setInputFiles('#vtt', vtt);
  await page.click('#file-import-vtt');
  await expect(page.locator('#hypertranscript')).toContainText('Hello there');
  await pollPage(page, async () => {
    const id = window.HyperaudioSave.library.currentId();
    const e = (await window.HyperaudioSave.library.list()).find((p) => p.id === id);
    return !!(e && e.media && e.media.kind);
  });
  return page.evaluate(async () => {
    const id = window.HyperaudioSave.library.currentId();
    const e = (await window.HyperaudioSave.library.list()).find((p) => p.id === id);
    return { kind: e.media.kind, url: e.media.url || null, src: document.getElementById('hyperplayer').src.slice(0, 24) };
  });
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { globalThis.hyperaudioLinkSchemes = ['app-media://']; });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.library.currentId())).not.toBeNull();
});

test('the host names a URL for the chosen file: the project is a link to it', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    window.hyperaudioMediaUrl = (file) => 'app-media://library/' + file.name + '?size=' + file.size;
  });
  const media = await importVtt(page, testInfo, 'talk');
  expect(media.kind).toBe('link');
  expect(media.url).toMatch(/^app-media:\/\/library\/talk\.mp4\?size=\d+$/);
  expect(media.src.startsWith('app-media://')).toBe(true);
});

test('no hook: the file goes on the player as a blob URL and the project carries its media', async ({ page }, testInfo) => {
  const media = await importVtt(page, testInfo, 'plain');
  expect(media).toMatchObject({ kind: 'original', url: null });
  expect(media.src.startsWith('blob:')).toBe(true);
});

for (const [name, hook] of [
  ['a hook that throws', 'window.hyperaudioMediaUrl = () => { throw new Error("no"); }'],
  ['a hook answering an undeclared scheme', 'window.hyperaudioMediaUrl = () => "https://cdn.example.com/talk.mp4"'],
  ['a hook answering null', 'window.hyperaudioMediaUrl = () => null'],
]) {
  test(`${name} leaves the blob URL`, async ({ page }, testInfo) => {
    await page.evaluate((code) => { eval(code); }, hook);
    const media = await importVtt(page, testInfo, 'kept');
    expect(media).toMatchObject({ kind: 'original', url: null });
    expect(media.src.startsWith('blob:')).toBe(true);
  });
}

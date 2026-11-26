// The SRT and VTT import dialogs. A video chosen in the caption box was read
// as captions: the import hung, then filled the transcript with thousands of
// garbage words. The caption file is checked first now, and refused with a
// message. And an import's captions are saved with the project: they used to
// play from a blob: address, which the save never read, so after a reload
// the file's own captions were gone, rebuilt from the transcript.
import { test, expect } from '@playwright/test';

const transcriptStart = (page) => page.evaluate(() => document.getElementById('hypertranscript').textContent.trim().slice(0, 40));
const projects = (page) => page.evaluate(async () => (await window.HyperaudioSave.library.list()).length);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => projects(page)).toBe(1);
});

for (const kind of ['vtt', 'srt']) {
  test(`a video in the ${kind.toUpperCase()} caption box is refused, and nothing is imported`, async ({ page }) => {
    const before = await transcriptStart(page);
    await page.evaluate((k) => { document.getElementById(`file-import-${k}-dialog`).checked = true; }, kind);
    await page.setInputFiles(`#${kind}`, { name: 'talk.mp4', mimeType: 'video/mp4', buffer: Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe]) });
    await page.click(`#file-import-${kind}`);
    await expect(page.locator('#project-dialog.modal-open')).toContainText('nothing was imported');
    await expect(page.locator('#project-dialog')).toContainText('media box');
    await page.click('#project-dialog-confirm');
    expect(await transcriptStart(page)).toBe(before);
    expect(await projects(page)).toBe(1);
  });
}

test('the boxes offer only their own kind of file', async ({ page }) => {
  const accepts = await page.evaluate(() => ['srt-file', 'srt', 'vtt-file', 'vtt'].map((id) => document.getElementById(id).accept));
  expect(accepts).toEqual(['audio/*,video/*', '.srt,application/x-subrip', 'audio/*,video/*', '.vtt,text/vtt']);
});

test('an SRT import\'s captions are saved with the project and come back after a reload', async ({ page }) => {
  await page.evaluate(() => { document.getElementById('file-import-srt-dialog').checked = true; });
  await page.setInputFiles('#srt', { name: 'three.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(
    '1\n00:00:00,500 --> 00:00:02,000\nThe Hyperaudio Lite Editor\n\n'
    + '2\n00:00:02,000 --> 00:00:04,000\nmakes audio and video\n\n'
    + '3\n00:00:04,000 --> 00:00:06,000\nmore accessible.\n') });
  await page.click('#file-import-srt');
  await expect(page.locator('#hypertranscript')).toContainText('more accessible');
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.getCaptionsVtt())).toContain('00:00:02.000 --> 00:00:04.000');

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect(page.locator('#hypertranscript')).toContainText('more accessible');
  await page.click('#caption-editor-btn');
  const divergence = page.locator('#project-dialog.modal-open');
  if (await divergence.isVisible()) await page.click('#project-dialog-confirm');
  await expect(page.locator('#captions-display .caption')).toHaveCount(3);
  await expect(page.locator('#captions-display .caption').nth(1).locator('.start')).toHaveValue('00:00:02.000');
});

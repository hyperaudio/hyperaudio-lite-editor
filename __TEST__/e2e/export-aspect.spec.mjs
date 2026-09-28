// #690 — portrait (9:16) and square (1:1) video for Reels, TikTok and Shorts.
import { test, expect } from '@playwright/test';

const FIXTURE = '/__TEST__/fixtures/video-640x360.mp4';

const setup = async (page) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate((src) => { document.getElementById('hyperplayer').src = src; }, FIXTURE);
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 2 && p.videoWidth === 640;
  });
  await page.evaluate(() => {
    document.getElementById('hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">one </span><span data-m="500" data-d="500">two </span></p></section></article>';
  });
  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
};

// the first video format this browser can encode
const videoFormat = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#export-format option')].map((o) => o.value).find((v) => v === 'mp4' || v === 'webm'));

// the exported file's picture size, read by the browser itself
const exportedSize = async (page) => {
  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-start');
  const download = await downloadPromise;
  await page.waitForFunction(() => document.getElementById('export-status').textContent.startsWith('Done'), null, { timeout: 120000 });
  const fs = await import('node:fs/promises');
  const b64 = (await fs.readFile(await download.path())).toString('base64');
  return page.evaluate(async ({ data, name }) => {
    const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    const v = document.createElement('video');
    v.src = URL.createObjectURL(new Blob([bytes], { type: name.endsWith('.webm') ? 'video/webm' : 'video/mp4' }));
    await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error('unreadable')); });
    return [v.videoWidth, v.videoHeight];
  }, { data: b64, name: download.suggestedFilename() });
};

const settle = (page, id, value) => page.evaluate(([i, v]) => {
  const el = document.getElementById(i);
  if (el.type === 'radio' || el.type === 'checkbox') el.checked = v; else el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, value]);

test('the aspect choice is offered for video formats only, and its framing controls follow it', async ({ page }) => {
  await setup(page);
  const video = await videoFormat(page);
  test.skip(!video, 'no video encoder in this browser');
  await page.selectOption('#export-format', video);
  await settle(page, 'export-aspect', 'original');
  await expect(page.locator('#export-frame-row')).toBeVisible();
  await expect(page.locator('#export-framing')).toBeHidden();
  await settle(page, 'export-aspect', 'portrait');
  await expect(page.locator('#export-framing')).toBeVisible();
  await expect(page.locator('#export-position-row')).toBeVisible();
  expect(await page.evaluate(() => { const c = document.getElementById('export-frame-preview'); return [c.width, c.height]; })).toEqual([90, 160]);
  // the preview shows the picture, not a blank frame, even though the player
  // has never played (a loaded, unplayed video has nothing to draw)
  await expect.poll(() => page.evaluate(() => {
    const c = document.getElementById('export-frame-preview');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit += 1;
    return lit > (c.width * c.height) / 4;
  })).toBe(true);
  await settle(page, 'export-fit-fit', true);
  await expect(page.locator('#export-position-row')).toBeHidden();
  await page.selectOption('#export-format', 'wav');
  await expect(page.locator('#export-frame-row')).toBeHidden();
});

test('the framing geometry: crop keeps the chosen slice; fit centres the whole picture; captions move clear of the apps', async ({ page }) => {
  await setup(page);
  const g = await page.evaluate(() => {
    const f = window.MediaExportFrame;
    return {
      portraitCentre: f.coverRegion(640, 360, 1080, 1920, 0.5),
      portraitLeft: f.coverRegion(640, 360, 1080, 1920, 0),
      portraitRight: f.coverRegion(640, 360, 1080, 1920, 1),
      square: f.coverRegion(640, 360, 1080, 1080, 0.5),
      fit: f.containRegion(640, 360, 1080, 1920),
      landscape: f.captionLayout(1920, 1080),
      portrait: f.captionLayout(1080, 1920),
    };
  });
  expect(g.portraitCentre).toEqual([218.75, 0, 202.5, 360]);
  expect(g.portraitLeft[0]).toBe(0);
  expect(g.portraitRight[0]).toBe(437.5);
  expect(g.square).toEqual([140, 0, 360, 360]);
  expect(g.fit).toEqual([0, 656.25, 1080, 607.5]);
  // one layout: landscape as it always was; a tall frame the same type and
  // column, lifted clear of the apps' own text
  expect(g.landscape).toEqual({ fontSize: 59, maxWidth: 1920 * 0.86, bottomMargin: 108, centreX: 960 });
  expect(g.portrait).toEqual({ fontSize: 59, maxWidth: 1080 * 0.86, bottomMargin: 1920 * 0.18, centreX: 540 });
});

for (const [aspect, fit, size] of [['portrait', 'crop', [1080, 1920]], ['square', 'fit', [1080, 1080]], ['original', 'crop', [640, 360]]]) {
  test(`a ${aspect} export (${fit}) comes out ${size.join('×')}`, async ({ page }) => {
    await setup(page);
    const video = await videoFormat(page);
    test.skip(!video, 'no video encoder in this browser');
    await page.selectOption('#export-format', video);
    await settle(page, 'export-aspect', aspect);
    await settle(page, fit === 'fit' ? 'export-fit-fit' : 'export-fit-crop', true);
    expect(await exportedSize(page)).toEqual(size);
  });
}

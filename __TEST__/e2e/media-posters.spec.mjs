import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ladderWav, withoutIntroProject } from './helpers.mjs';

// #523 phase A — poster capture and the hover-card thumbnail. The video
// fixture is synthesized in-page (canvas + MediaRecorder); the capture,
// storage and display layers are exercised separately so no full
// video-project flow is needed.

const makeWebmBlob = () => new Promise((resolve) => {
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#a63'; ctx.fillRect(0, 0, 320, 180);
  const stream = canvas.captureStream(10);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
  rec.start();
  let frames = 0;
  const tick = setInterval(() => {
    ctx.fillRect(0, 0, 320, 180);
    if (++frames >= 12) { clearInterval(tick); rec.stop(); }
  }, 100);
});

test('captureFrameBlob: a jpeg for video, null for audio (#523)', async ({ page }, testInfo) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const wavPath = testInfo.outputPath('tone.wav');
  fs.writeFileSync(wavPath, ladderWav(1));
  const wavB64 = fs.readFileSync(wavPath).toString('base64');
  const result = await page.evaluate(`(async () => {
    const videoBlob = await (${makeWebmBlob.toString()})();
    const videoUrl = URL.createObjectURL(videoBlob);
    const jpeg = await window.MediaPosters.captureFrameBlob(videoUrl);
    return { jpegType: jpeg ? jpeg.type : null, jpegSize: jpeg ? jpeg.size : 0 };
  })()`);
  expect(result.jpegType).toBe('image/jpeg');
  expect(result.jpegSize).toBeGreaterThan(500);

  const audioNull = await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    return window.MediaPosters.captureFrameBlob(url);
  }, wavB64);
  expect(audioNull).toBeNull();
});

test('ensureProjectPoster writes poster.jpg from stored video media (#523)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const written = await page.evaluate(`(async () => {
    const blob = await (${makeWebmBlob.toString()})();
    const root = await navigator.storage.getDirectory();
    const work = await root.getDirectoryHandle('work', { create: true });
    const dir = await work.getDirectoryHandle('poster-test-project', { create: true });
    const media = await dir.getDirectoryHandle('media', { create: true });
    const fh = await media.getFileHandle('clip.webm', { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close();

    await window.MediaPosters.ensureProjectPoster('poster-test-project');
    try {
      const poster = await (await dir.getFileHandle('poster.jpg')).getFile();
      return { size: poster.size, type: poster.type };
    } catch (e) { return null; }
  })()`);
  expect(written).not.toBeNull();
  expect(written.size).toBeGreaterThan(500);
});

test('the hover popout shows the stored poster, or the wave glyph without one (#523)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(async () => {
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    for (let i = 0; i < 50 && window.HyperaudioSave.library.currentId() === null; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  const id = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  expect(id).not.toBeNull();

  // no poster stored (the intro is audio): the wave glyph — now the very
  // image the player shows for it (#603), not a second drawing of one
  await page.hover('#file-picker .recents-row .file-item');
  await expect(page.locator('#recents-popout .recents-popout-thumb img.recents-popout-glyph'))
    .toBeVisible();
  await page.mouse.move(10, 10);

  // plant a poster; a fresh hover swaps the glyph for the image
  await page.evaluate(`(async (id) => {
    const blob = await (${makeWebmBlob.toString()})();
    const jpeg = await window.MediaPosters.captureFrameBlob(URL.createObjectURL(blob));
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
    const fh = await dir.getFileHandle('poster.jpg', { create: true });
    const w = await fh.createWritable(); await w.write(jpeg); await w.close();
  })(${JSON.stringify(id)})`);
  await page.hover('#file-picker .recents-row .file-item');
  await expect(page.locator('#recents-popout img.recents-popout-poster')).toBeVisible({ timeout: 5000 });
});

// #575's other half, which the standalone fixture cannot show: in the app the
// player must end up wearing THIS project's stored capture, not the frozen
// frame of the one before it and not the intro artwork. Chromium, because the
// app needs OPFS and Playwright's WebKit has none.
test('the player wears the project\'s own capture after a switch (#575)', async ({ page }) => {
  await withoutIntroProject(page); // the two projects here are the subject (#602)
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  const make = async (name) => {
    await page.evaluate(async (name) => {
      const blob = await window.__makeWebmForTest();
      const file = new File([blob], name + '.webm', { type: 'video/webm' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById('file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('hyperplayer').src = URL.createObjectURL(file);
      document.dispatchEvent(new CustomEvent('hyperaudioInit'));
      const lib = window.HyperaudioSave.library;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const id = lib.currentId();
        if (id !== null && (await lib.list()).some((e) => e.id === id)) break;
      }
      await window.HyperaudioSave.saveProject();
    }, name);
    await page.waitForTimeout(1200);
  };

  await page.addScriptTag({ content: `window.__makeWebmForTest = ${makeWebmBlob.toString()};` });
  await make('First');
  await make('Second');
  const ids = await page.evaluate(async () =>
    (await window.HyperaudioSave.library.list()).map((e) => e.id));

  await page.evaluate((id) => window.HyperaudioSave.library.open(id), ids[ids.length - 1]);

  // it settles on a stored capture: a blob URL, not the previous project's
  // frozen data: URL and not the markup's poster
  await expect.poll(async () => {
    const poster = await page.getAttribute('#hyperplayer', 'poster');
    return poster === null ? 'none' : poster.split(':')[0];
  }, { timeout: 15000 }).toBe('blob');
});

// #582 — frame 1 is the likeliest black frame in a clip (fade-ins, a camera
// still settling), and a black capture was permanent. The capture now starts
// around 5s, refuses a flat-black frame and tries other offsets, and writes
// nothing rather than black; a stored black poster is captured again.
const makeClip = (paintSource, frames) => new Promise((resolve) => {
  const paint = eval(paintSource);
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext('2d');
  paint(ctx, 0);
  const stream = canvas.captureStream(10);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
  rec.start();
  let n = 0;
  const tick = setInterval(() => {
    paint(ctx, ++n);
    if (n >= frames) { clearInterval(tick); rec.stop(); }
  }, 100);
});
// "black" for the first 2 s (20 frames at 10 fps), then orange. Charcoal,
// not #000: that is what black video decodes to in practice, and what the
// stuck posters in the wild look like.
const blackThenOrange = `(ctx, n) => { ctx.fillStyle = n < 20 ? '#1c1c1e' : '#e80'; ctx.fillRect(0, 0, 320, 180); }`;
const allBlack = `(ctx) => { ctx.fillStyle = '#1c1c1e'; ctx.fillRect(0, 0, 320, 180); }`;

const meanLuma = async (page, blobExpr) => page.evaluate(`(async () => {
  const blob = await (${blobExpr});
  if (!blob) return null;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = 16; c.height = 16;
  const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  let sum = 0; for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return sum / 256;
})()`);

test('the candidates start around 5s and end with the first frame, clipped to the clip (#582)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const c = await page.evaluate(() => ({
    long: window.MediaPosters.captureCandidates(1320),   // 22 minutes
    short: window.MediaPosters.captureCandidates(4),
    tiny: window.MediaPosters.captureCandidates(0.3),
    unknown: window.MediaPosters.captureCandidates(Infinity),
  }));
  expect(c.long).toEqual([5, 10, 330, 0.5, 0.0001]);
  expect(c.short).toEqual([2, 3, 1, 0.5, 0.0001]);
  expect(c.tiny).toEqual([0.15]);   // everything else is within the 0.2s dedupe window
  expect(c.unknown).toEqual([5, 0.0001]);
});

test('a clip that opens black gets a poster from where the picture is (#582)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(`window.__clip = (${makeClip.toString()})(${JSON.stringify(blackThenOrange)}, 40)`);
  const luma = await meanLuma(page, `window.MediaPosters.captureFrameBlob(URL.createObjectURL(await window.__clip))`);
  expect(luma).not.toBeNull();
  expect(luma).toBeGreaterThan(100);   // orange, not the black lead-in (0 before)
});

test('a clip that is black throughout gets NO poster rather than a black one (#582)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(`window.__clip = (${makeClip.toString()})(${JSON.stringify(allBlack)}, 20)`);
  const result = await page.evaluate(`(async () => window.MediaPosters.captureFrameBlob(URL.createObjectURL(await window.__clip)))()`);
  expect(result).toBeNull();
});

test('a stored black poster is captured again, so an old black thumbnail is not for ever (#582)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const r = await page.evaluate(`(async () => {
    const clip = await (${makeClip.toString()})(${JSON.stringify(blackThenOrange)}, 40);
    const root = await navigator.storage.getDirectory();
    const work = await root.getDirectoryHandle('work', { create: true });
    const dir = await work.getDirectoryHandle('black-poster-project', { create: true });
    const media = await dir.getDirectoryHandle('media', { create: true });
    let fh = await media.getFileHandle('clip.webm', { create: true });
    let w = await fh.createWritable(); await w.write(clip); await w.close();
    // the poster an earlier capture left: a flat charcoal jpeg
    const c = document.createElement('canvas'); c.width = 320; c.height = 180;
    const cx = c.getContext('2d'); cx.fillStyle = '#1c1c1e'; cx.fillRect(0, 0, 320, 180);
    const black = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.75));
    fh = await dir.getFileHandle('poster.jpg', { create: true });
    w = await fh.createWritable(); await w.write(black); await w.close();
    const before = (await (await dir.getFileHandle('poster.jpg')).getFile()).size;

    await window.MediaPosters.ensureProjectPoster('black-poster-project');
    window.__after = await (await dir.getFileHandle('poster.jpg')).getFile();
    return { before, after: window.__after.size };
  })()`);
  expect(r.after).not.toBe(r.before);
  const luma = await meanLuma(page, 'window.__after');
  expect(luma).toBeGreaterThan(100);
});

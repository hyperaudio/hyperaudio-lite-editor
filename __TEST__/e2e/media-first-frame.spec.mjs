import { test, expect } from '@playwright/test';
import { ladderWav } from './helpers.mjs';

// #556 — first-frame display for video media. Video drops the generic demo
// poster and takes an epsilon seek so the real first frame paints; audio
// keeps the poster; the aspect-ratio pin follows the medium. The video
// fixture is synthesized in-page (canvas.captureStream + MediaRecorder), so
// no binary fixture is checked in.
const makeWebm = () => new Promise((resolve) => {
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 240;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3a6'; ctx.fillRect(0, 0, 320, 240);
  const stream = canvas.captureStream(10);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => resolve(URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })));
  rec.start();
  let frames = 0;
  const tick = setInterval(() => {
    ctx.fillRect(0, 0, 320, 240); // keep frames flowing
    if (++frames >= 12) { clearInterval(tick); rec.stop(); }
  }, 100);
});

test('video media drops the poster, paints frame one, and pins its aspect (#556)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // the demo is audio: the generic poster must be present at boot
  await expect(page.locator('#hyperplayer')).toHaveAttribute('poster', /poster/);

  await page.evaluate(`(${makeWebm.toString()})().then((url) => {
    document.getElementById('hyperplayer').src = url;
  })`);
  const player = page.locator('#hyperplayer');
  await expect(player).not.toHaveAttribute('poster', /.*/, { timeout: 10000 }); // poster dropped
  const state = await page.evaluate(() => {
    const p = document.getElementById('hyperplayer');
    return { aspect: p.style.aspectRatio, time: p.currentTime, paused: p.paused };
  });
  expect(state.aspect).toBe('320 / 240');
  expect(state.time).toBeGreaterThan(0);   // the epsilon nudge decoded frame one
  expect(state.time).toBeLessThan(0.1);    // ...and stayed at the start
  expect(state.paused).toBe(true);
});

test('audio media keeps the poster and clears the aspect pin (#556)', async ({ page }, testInfo) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // video first, so the poster is gone and the pin is set...
  await page.evaluate(`(${makeWebm.toString()})().then((url) => {
    document.getElementById('hyperplayer').src = url;
  })`);
  const player = page.locator('#hyperplayer');
  await expect(player).not.toHaveAttribute('poster', /.*/, { timeout: 10000 });

  // ...then audio: the generic poster returns and the pin releases
  const wavPath = testInfo.outputPath('tone.wav');
  (await import('node:fs')).writeFileSync(wavPath, ladderWav(1));
  const buf = (await import('node:fs')).readFileSync(wavPath);
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    document.getElementById('hyperplayer').src = url;
  }, buf.toString('base64'));
  await expect(player).toHaveAttribute('poster', /poster/, { timeout: 10000 });
  expect(await page.evaluate(() => document.getElementById('hyperplayer').style.aspectRatio)).toBe('');
});

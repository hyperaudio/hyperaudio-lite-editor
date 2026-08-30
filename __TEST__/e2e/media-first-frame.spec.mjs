import { test, expect } from '@playwright/test';
import { ladderWav } from './helpers.mjs';

// #556 — first-frame display for video media, as amended by #575. The
// original shape (drop the poster, epsilon-seek so the decoder paints frame
// one) turned out to strand WebKit in a display mode it never leaves, so the
// poster is now never removed and the picture comes from the project's stored
// capture instead. What survives from #556 is the intent: a video project
// shows its own first frame rather than the demo artwork, audio keeps the
// artwork, and the aspect-ratio pin follows the medium. The video fixture is
// synthesized in-page (canvas.captureStream + MediaRecorder), so no binary
// fixture is checked in.
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

test('video media pins its aspect and keeps a poster throughout (#556/#575)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // the intro is audio, so it wears the wave glyph at boot (#603) — the
  // markup poster is the intro audio's artwork and no longer stands in for
  // whatever project happens to be open
  await expect(page.locator('#hyperplayer')).toHaveAttribute('poster', /^data:image\/svg/);

  await page.evaluate(`(${makeWebm.toString()})().then((url) => {
    document.getElementById('hyperplayer').src = url;
  })`);
  const player = page.locator('#hyperplayer');
  await expect(player).toHaveAttribute('style', /aspect-ratio/, { timeout: 10000 });
  const state = await page.evaluate(() => {
    const p = document.getElementById('hyperplayer');
    return { aspect: p.style.aspectRatio, poster: p.getAttribute('poster'), paused: p.paused };
  });
  expect(state.aspect).toBe('320 / 240');
  // #575: never posterless, and never seeked. Loose media like this has no
  // project behind it and so no stored capture — what matters is that the
  // element keeps SOMETHING, because a video element that has gone bare
  // cannot be given a poster again in WebKit.
  expect(state.poster).not.toBe(null);
  expect(state.paused).toBe(true);
});

test('audio media keeps the poster and clears the aspect pin (#556)', async ({ page }, testInfo) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // video first, so the pin is set (the poster stays, per #575)...
  await page.evaluate(`(${makeWebm.toString()})().then((url) => {
    document.getElementById('hyperplayer').src = url;
  })`);
  const player = page.locator('#hyperplayer');
  await expect(player).toHaveAttribute('style', /aspect-ratio/, { timeout: 10000 });

  // ...then audio: the generic poster returns and the pin releases
  const wavPath = testInfo.outputPath('tone.wav');
  (await import('node:fs')).writeFileSync(wavPath, ladderWav(1));
  const buf = (await import('node:fs')).readFileSync(wavPath);
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    document.getElementById('hyperplayer').src = url;
  }, buf.toString('base64'));
  // Wait on the PIN, not the poster: since #575 the poster is never removed,
  // so /poster/ still matches the artwork left over from boot and would pass
  // before the audio has loaded anything. The pin releasing is the signal
  // that this medium has been recognised as audio.
  await expect.poll(
    () => page.evaluate(() => document.getElementById('hyperplayer').style.aspectRatio),
    { timeout: 10000 },
  ).toBe('');
  await expect(player).toHaveAttribute('poster', /^data:image\/svg/); // the glyph, not the artwork (#603)
});

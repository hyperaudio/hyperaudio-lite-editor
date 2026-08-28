// #590: a <video> forgets its intrinsic size the moment src changes, so
// switching projects used to collapse the media box to nothing and spring it
// back — the controls, the panel and the transcript jumping ~430px each way.
// This measures the thing that actually hurt: whether content BELOW the
// player holds still while the media is swapped.
import { test, expect } from '@playwright/test';

const makeWebm = (colour) => `(() => new Promise((resolve) => {
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '${colour}'; ctx.fillRect(0, 0, 320, 180);
  const stream = canvas.captureStream(10);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
  rec.start();
  let f = 0;
  const t = setInterval(() => { ctx.fillRect(0,0,320,180); if (++f >= 8) { clearInterval(t); rec.stop(); } }, 60);
}))()`;

async function makeVideoProject(page, colour, name) {
  await page.evaluate(async ([js, name]) => {
    const blob = await eval(js);
    const file = new File([blob], name + '.webm', { type: 'video/webm' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('hyperplayer').src = URL.createObjectURL(file);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    const lib = window.HyperaudioSave.library;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const id = lib.currentId();
      if (id !== null && (await lib.list()).some((e) => e.id === id)) break;
    }
    await window.HyperaudioSave.saveProject();
  }, [makeWebm(colour), name]);
  await page.waitForTimeout(800);
}

test('switching projects keeps the media box sized and unbranded (#590)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  await makeVideoProject(page, '#a63', 'One');
  await makeVideoProject(page, '#36a', 'Two');
  const ids = await page.evaluate(async () =>
    (await window.HyperaudioSave.library.list()).map((e) => e.id));

  // Sampling for the collapse itself is hopeless here: a tiny local blob
  // reports its metadata within a frame or two, so the jolt seen against real
  // media never has time to paint. Watch the two things that CAUSED it — the
  // aspect pin being dropped and the generic poster being restored — with a
  // MutationObserver, which catches them however briefly they last.
  const seen = await page.evaluate(async (id) => {
    const player = document.getElementById('hyperplayer');
    const pinBefore = player.style.aspectRatio;
    let pinCleared = false;
    let brandedPoster = false;
    const watch = new MutationObserver(() => {
      if (player.style.aspectRatio === '') pinCleared = true;
      // "branded" means the markup's poster — the intro audio's artwork.
      // A stored capture is a blob: URL and is exactly what SHOULD be here
      // (#575), so test for the artwork itself rather than for "not data:".
      const poster = player.getAttribute('poster');
      if (poster !== null && poster.includes('images/poster.png')) brandedPoster = true;
    });
    watch.observe(player, { attributes: true, attributeFilter: ['style', 'poster', 'src'] });
    await window.HyperaudioSave.library.open(id);
    await new Promise((r) => setTimeout(r, 1500));
    watch.disconnect();
    return {
      pinBefore, pinCleared, brandedPoster,
      pinAfter: player.style.aspectRatio,
      posterAfter: player.getAttribute('poster'),
    };
  }, ids[1]);

  // the box was pinned to an aspect ratio before AND after, and never let go
  // of one in between — so nothing below it could move
  expect(seen.pinBefore).not.toBe('');
  expect(seen.pinAfter).not.toBe('');
  expect(seen.pinCleared).toBe(false);

  // and the hyperaudio wordmark never went up: the outgoing frame covered the
  // gap, then this project's own capture replaced it. Never posterless —
  // that is the WebKit trap #575 documents.
  expect(seen.brandedPoster).toBe(false);
  expect(seen.posterAfter).not.toBe(null);
});

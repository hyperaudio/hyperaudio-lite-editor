// #603 — an audio project has no frame to capture, so the player fell back to
// the markup poster: the INTRO audio's artwork. Every audio project therefore
// wore the same face, and the same project looked different in the library
// (which has drawn audio a wave glyph since #523) than in the player. Both
// now draw the one glyph, from media-posters.
import { test, expect } from '@playwright/test';

const posterKind = (page) => page.evaluate(() => {
  const poster = document.getElementById('hyperplayer').getAttribute('poster') || '';
  if (poster.startsWith('data:image/svg')) return 'glyph';
  if (poster.includes('images/poster.png')) return 'intro-artwork';
  if (poster.startsWith('blob:')) return 'stored-capture';
  return poster.slice(0, 40);
});

test('an audio project shows the wave glyph, not the intro artwork (#603)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => posterKind(page)).toBe('glyph');
  expect(await page.evaluate(() => document.getElementById('hyperplayer').videoWidth)).toBe(0);
});

test('the player and the library draw the SAME glyph (#603)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => posterKind(page)).toBe('glyph');

  // one picture, two places: the hue is per-project, so a mismatch here means
  // the two have drifted apart again
  const agree = await page.evaluate(() => {
    const poster = decodeURIComponent(document.getElementById('hyperplayer').getAttribute('poster'));
    const inPlayer = (poster.match(/hsl\((\d+)/) || [])[1];
    const id = window.HyperaudioSave.library.currentId();
    return { inPlayer: Number(inPlayer), inLibrary: window.MediaPosters.glyphHue(id) };
  });
  expect(agree.inPlayer).toBe(agree.inLibrary);
  expect(Number.isFinite(agree.inPlayer)).toBe(true);
});

test('an embedder poster still wins over the glyph (#603)', async ({ page }) => {
  await page.addInitScript(() => {
    window.hyperaudioMediaPoster = () => 'images/poster.png'; // any host-supplied url
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // the hook's answer, not the glyph — the ordering the issue asked for
  await expect.poll(() => posterKind(page)).toBe('intro-artwork');
});

test('the glyph is 16:9, so the player keeps its shape (#603)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => posterKind(page)).toBe('glyph');
  // a square glyph would make the media area square when audio loads
  const box = await page.evaluate(() => {
    const svg = decodeURIComponent(document.getElementById('hyperplayer').getAttribute('poster'));
    const w = Number((svg.match(/width="(\d+)"/) || [])[1]);
    const h = Number((svg.match(/height="(\d+)"/) || [])[1]);
    return { w, h, ratio: w / h };
  });
  expect(box.ratio).toBeCloseTo(16 / 9, 2);
});

test('switching between audio projects changes the glyph with it (#603)', async ({ page }) => {
  // The glyph is per-project, so a stale one is a project wearing another's
  // face. This missed the first time because the spec only ever had ONE
  // project: applyStoredPoster waited on ensureProjectPoster, and a capture on
  // audio has nothing to draw — it only resolves on its 8s timeout, so the
  // outgoing glyph stayed put for eight seconds after every switch.
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForTimeout(1500);

  await page.evaluate(async () => {
    const sr = 8000, n = sr * 2, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i += 1) dv.setInt16(44 + i * 2, Math.sin(i / 18) * 3000, true);
    const file = new File([buf], 'second.wav', { type: 'audio/wav' });
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
  });
  await page.waitForTimeout(1200);

  const ids = await page.evaluate(async () =>
    (await window.HyperaudioSave.library.list()).map((e) => e.id));
  expect(ids.length).toBe(2);

  const shownHue = () => page.evaluate(() => {
    const poster = decodeURIComponent(
      document.getElementById('hyperplayer').getAttribute('poster') || '');
    return {
      shown: Number((poster.match(/hsl\((\d+)/) || [])[1]),
      expected: window.MediaPosters.glyphHue(window.HyperaudioSave.library.currentId()),
    };
  });

  for (const id of [ids[1], ids[0], ids[1]]) {
    await page.evaluate((i) => window.HyperaudioSave.library.open(i), id);
    // deliberately shorter than the capture timeout: the point is that the
    // glyph arrives promptly, not eventually
    await expect.poll(shownHue, { timeout: 4000 })
      .toEqual(await shownHue().then((h) => ({ shown: h.expected, expected: h.expected })));
  }
});

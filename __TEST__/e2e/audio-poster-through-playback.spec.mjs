// #629 — WebKit stops painting a <video>'s poster the moment playback starts,
// even when the medium is audio and no frame will ever replace it: the
// attribute stays, the picture goes, and an audio project plays as a bare
// box. Blink keeps the poster until a frame arrives, so Chrome never showed
// it, and nothing observable from JS distinguishes the two states — the
// poster attribute reads intact throughout. So this screenshots the frame
// through a play, in WebKit itself, and asks whether a picture is still there.
import { test, expect, webkit } from '@playwright/test';
import { pngMeanRGB } from './png-luma.mjs';
import { ladderWav } from './helpers.mjs';

// A local WAV on the player, as the sibling specs do: headless WebKit does
// not reliably start the intro's remote MP3, and the point is the poster.
const loadWav = (page) => page.evaluate((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const el = document.getElementById('hyperplayer');
  el.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  return new Promise((resolve) => el.addEventListener('loadedmetadata', resolve, { once: true }));
}, ladderWav(4).toString('base64'));

const glyphShowing = (page) => page.evaluate(() =>
  (document.getElementById('hyperplayer').getAttribute('poster') || '').startsWith('data:image/svg'));

const playFor = (page, seconds) => page.evaluate(async (s) => {
  const el = document.getElementById('hyperplayer');
  el.muted = true;
  await el.play();
  const start = el.currentTime;
  const deadline = Date.now() + 15000;
  while (el.currentTime < start + s && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { currentTime: el.currentTime, paused: el.paused, videoWidth: el.videoWidth,
           poster: (el.getAttribute('poster') || '').slice(0, 20) };
}, seconds);

test('WebKit: an audio project keeps its picture through playback (#629)', async () => {
  let browser;
  try {
    browser = await webkit.launch();
  } catch (e) {
    test.skip(true, 'WebKit build not installed: ' + e.message);
    return;
  }
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto('http://localhost:4173/index.html');
    await page.waitForSelector('#hypertranscript [data-m]');
    await loadWav(page);
    await expect.poll(() => glyphShowing(page)).toBe(true);
    // A corner of the frame, clear of the bars, the play badge and the
    // captions: the glyph's pastel fill has chroma, the page background that
    // shows through when the element paints nothing has none. A distinct-luma
    // count over the whole frame is fooled by the captions.
    const box = await page.locator('#player-frame').boundingBox();
    const corner = { x: box.x + 8, y: box.y + 8, width: 24, height: 24 };
    const before = pngMeanRGB(await page.screenshot({ clip: corner }));
    expect(before.spread, 'the glyph paints before play').toBeGreaterThanOrEqual(20);

    const state = await playFor(page, 0.5);
    expect(state, 'playback did not get going').toMatchObject({ paused: false });
    expect(state.currentTime).toBeGreaterThan(0.4);
    expect(state.videoWidth).toBe(0);
    expect(state.poster.startsWith('data:image/svg')).toBe(true);   // the attribute never changed

    const during = pngMeanRGB(await page.screenshot({ clip: corner }));
    // the bug: grey — the element painting nothing, the page background
    // showing through — with the poster attribute still intact
    expect(during.spread, `the picture vanished once playback started (${JSON.stringify(during)})`)
      .toBeGreaterThanOrEqual(20);
  } finally {
    await browser.close();
  }
});

test('the underlay mirrors the poster for audio and follows it when it changes (#629)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => glyphShowing(page)).toBe(true);
  const underlay = page.locator('#media-poster-underlay');
  await expect(underlay).toBeVisible();
  const agree = await page.evaluate(() =>
    document.getElementById('media-poster-underlay').getAttribute('src') ===
    document.getElementById('hyperplayer').getAttribute('poster'));
  expect(agree).toBe(true);

  // it sits BEHIND the element, so captions and the play badge stay on top
  const order = await page.evaluate(() => {
    const u = document.getElementById('media-poster-underlay');
    return { next: u.nextElementSibling && u.nextElementSibling.id, z: getComputedStyle(u).zIndex };
  });
  expect(order).toEqual({ next: 'hyperplayer', z: '-1' });

  // an embedder or a stored capture replacing the glyph is followed
  await page.evaluate(() => document.getElementById('hyperplayer').setAttribute('poster', 'images/poster.png'));
  await expect.poll(() => page.evaluate(() =>
    document.getElementById('media-poster-underlay').getAttribute('src'))).toBe('images/poster.png');
});

test('the underlay hides while a new medium loads, until it is known to be audio (#629)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect(page.locator('#media-poster-underlay')).toBeVisible();
  await page.evaluate(() => {
    // a loadstart with nothing to say yet: the underlay must not stay up
    // wearing the previous project's picture over a medium that may be video
    const el = document.getElementById('hyperplayer');
    el.dispatchEvent(new Event('loadstart'));
  });
  await expect(page.locator('#media-poster-underlay')).toBeHidden();
});

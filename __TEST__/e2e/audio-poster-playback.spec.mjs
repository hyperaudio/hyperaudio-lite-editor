// #629 — WebKit leaves poster display mode the moment playback starts, even
// for audio, where no frame is ever coming and the poster attribute is still
// set: the player went to a bare box for the rest of the play, and its
// intrinsic size fell back to 300x150 so the layout jumped too. The same
// picture is painted again as an <img> behind the player, which WebKit has no
// reason to stop drawing. Chromium never had the bug; it runs here to keep the
// duplicate honest in the engine that does work.
import { test, expect, webkit, chromium } from '@playwright/test';
import { ladderWav } from './helpers.mjs';

const AUDIO = ladderWav(3).toString('base64');

const playerState = (page) => page.evaluate(() => {
  const player = document.getElementById('hyperplayer');
  const img = document.getElementById('audio-poster');
  const box = player.getBoundingClientRect();
  return {
    posterAttr: (player.getAttribute('poster') || '').slice(0, 24),
    imgPresent: img !== null,
    imgShown: img !== null && !img.hidden,
    imgSrcMatchesPoster: img !== null && img.getAttribute('src') === player.getAttribute('poster'),
    ratio: +(box.width / box.height).toFixed(2),
    currentTime: player.currentTime,
    videoWidth: player.videoWidth,
  };
});

// Put a local audio file on the player and let the module settle it.
const loadAudio = (page, b64) => page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const player = document.getElementById('hyperplayer');
  player.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  await new Promise((resolve) => {
    player.addEventListener('loadedmetadata', resolve, { once: true });
    setTimeout(resolve, 5000);
  });
}, b64);

for (const [engineName, engine] of [['WebKit', webkit], ['Chromium', chromium]]) {
  test(`${engineName}: an audio project keeps its picture once playback starts (#629)`, async () => {
    let browser;
    try {
      browser = await engine.launch();
    } catch (e) {
      test.skip(true, `${engineName} build not installed: ${e.message}`);
      return;
    }
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto('http://localhost:4173/index.html');
      await page.waitForSelector('#hypertranscript [data-m]');
      await loadAudio(page, AUDIO);
      // Choosing a poster is asynchronous — the markup one is replaced by the
      // project's glyph — so let it settle before sampling, or the comparison
      // races the module's own upgrade rather than testing playback.
      await expect.poll(async () => (await playerState(page)).imgSrcMatchesPoster).toBe(true);
      await page.waitForTimeout(1000);
      await expect.poll(async () => (await playerState(page)).imgSrcMatchesPoster).toBe(true);

      const before = await playerState(page);
      expect(before.videoWidth).toBe(0);                 // audio: no frame, ever
      expect(before.imgShown).toBe(true);
      expect(before.imgSrcMatchesPoster).toBe(true);
      expect(before.ratio).toBeGreaterThan(1.5);         // the glyph's 16:9, not 300x150

      // a real gesture, so autoplay policy cannot refuse
      await page.click('#media-play-overlay');
      await expect.poll(async () => (await playerState(page)).currentTime, { timeout: 5000 }).toBeGreaterThan(0.2);

      const during = await playerState(page);
      expect(during.imgShown).toBe(true);
      expect(during.imgSrcMatchesPoster).toBe(true);
      expect(during.posterAttr).toBe(before.posterAttr); // the attribute never moved
      // the box keeps the picture's ratio: no 300x150 collapse mid-play
      expect(Math.abs(during.ratio - before.ratio)).toBeLessThan(0.05);

      // and the pixels agree: a patch of the picture — inside the frame, clear
      // of the rounded corner and of the play badge — looks the same a second
      // in as it did before. This is the regression itself: without the
      // duplicate, WebKit's patch goes blank here the moment playback starts.
      const box = await page.locator('#player-frame').boundingBox();
      const patch = { x: Math.round(box.x) + 20, y: Math.round(box.y) + 20, width: 16, height: 16 };
      const shotBefore = await page.screenshot({ clip: patch });
      await page.waitForTimeout(400);
      const shotDuring = await page.screenshot({ clip: patch });
      expect(Buffer.compare(shotBefore, shotDuring)).toBe(0);
    } finally {
      await browser.close();
    }
  });
}

test('video hides the duplicate: frames paint themselves (#629)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await loadAudio(page, AUDIO);
  expect((await playerState(page)).imgShown).toBe(true);

  await page.evaluate(async () => {
    const player = document.getElementById('hyperplayer');
    player.src = '/__TEST__/fixtures/video-320x240.mp4';
    await new Promise((resolve) => {
      player.addEventListener('loadeddata', resolve, { once: true });
      setTimeout(resolve, 5000);
    });
  });
  await expect.poll(async () => (await playerState(page)).imgShown).toBe(false);
});

test('the duplicate follows the poster attribute wherever it comes from (#629)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await loadAudio(page, AUDIO);

  // Choosing a poster is asynchronous (a stored capture, then the glyph), so
  // wait for the module to settle before standing in for a later arrival —
  // otherwise its own pass lands after the change and the test races it.
  const mirrors = () => page.evaluate(() => {
    const player = document.getElementById('hyperplayer');
    const img = document.getElementById('audio-poster');
    return img !== null && !img.hidden && img.getAttribute('src') === player.getAttribute('poster');
  });
  await expect.poll(mirrors).toBe(true);
  await page.waitForTimeout(1200);
  await expect.poll(mirrors).toBe(true);

  // a capture arriving late, an embedder answering: both reach the player the
  // same way, and the duplicate must follow
  await page.evaluate(() => {
    document.getElementById('hyperplayer').setAttribute('poster', 'images/poster.png');
  });
  await expect.poll(() => page.evaluate(() => document.getElementById('audio-poster').getAttribute('src')))
    .toBe('images/poster.png');
});

// The picture is clipped at the frame, not by each layer inside it: a video
// element's own border-radius does not reliably clip what WebKit paints into
// it, so an audio poster could come out square-cornered against the rounded
// card. Sampled where the rounding must show — the very corner of the frame
// is page background, not picture.
for (const [engineName, engine] of [['WebKit', webkit], ['Chromium', chromium]]) {
  test(`${engineName}: the audio picture keeps the card's rounded corners (#629)`, async () => {
    let browser;
    try {
      browser = await engine.launch();
    } catch (e) {
      test.skip(true, `${engineName} build not installed: ${e.message}`);
      return;
    }
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto('http://localhost:4173/index.html');
      await page.waitForSelector('#hypertranscript [data-m]');
      await loadAudio(page, AUDIO);
      await expect.poll(async () => (await playerState(page)).imgShown).toBe(true);

      const at = await page.evaluate(() => {
        const r = document.getElementById('player-frame').getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y) };
      });
      // 2x2 at the very corner: well outside an 8px radius, and clear of the
      // antialiasing along the curve, so it is background or the clip failed
      const corner = () => page.screenshot({ clip: { x: at.x, y: at.y, width: 2, height: 2 } });
      const background = await page.screenshot({ clip: { x: at.x - 8, y: at.y - 8, width: 2, height: 2 } });

      expect(Buffer.compare(await corner(), background)).toBe(0);
      await page.click('#media-play-overlay');
      await expect.poll(async () => (await playerState(page)).currentTime, { timeout: 5000 }).toBeGreaterThan(0.2);
      expect(Buffer.compare(await corner(), background)).toBe(0);   // and it stays rounded through the play
    } finally {
      await browser.close();
    }
  });
}

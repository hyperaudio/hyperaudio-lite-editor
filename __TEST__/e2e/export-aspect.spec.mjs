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

// #711 — WebKit ignores a source rectangle when the source is a VideoFrame and
// squeezes the whole frame into the output. So a frame is only ever drawn
// whole, placed so that the wanted region lands on the canvas. This pins the
// placement to coverRegion and the calls to the destination-only form. It
// cannot see WebKit's behaviour itself, which needs WebKit decoding a frame.
test('a cropped frame is drawn whole and placed, never with a source rectangle', async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(() => {
    const f = window.MediaExportFrame;
    const worst = [];
    for (const [srcW, srcH] of [[640, 360], [1280, 720], [314, 240], [720, 1280]]) {
      for (const [W, H] of [[1080, 1920], [1080, 1080], [45, 80]]) {
        for (const p of [0, 0.3, 0.5, 1]) {
          const [sx, sy, sw, sh] = f.coverRegion(srcW, srcH, W, H, p);
          const [dx, dy, dw, dh] = f.coverPlacement(srcW, srcH, W, H, p);
          // the region's corners land on the canvas corners
          worst.push(Math.abs(dx + sx * dw / srcW), Math.abs(dy + sy * dh / srcH),
            Math.abs(sw * dw / srcW - W), Math.abs(sh * dh / srcH - H));
        }
      }
    }
    const calls = (frame) => {
      const seen = [];
      const sample = { draw: (...args) => seen.push(args.slice(1)) };
      const c = document.createElement('canvas').getContext('2d');
      f.makeFrameDrawer(frame, 640, 360, 1080, 1920)(sample, c);
      return seen;
    };
    return {
      worst: Math.max(...worst),
      crop: calls({ aspect: 'portrait', fit: 'crop', position: 1 }),
      fit: calls({ aspect: 'portrait', fit: 'fit' }),
    };
  });
  expect(r.worst).toBeLessThan(1e-9);
  // 640x360 scaled to fill 1920 high is 3413.33 wide, pushed left to keep the right edge
  expect(r.crop).toHaveLength(1);
  expect(r.crop[0]).toHaveLength(4);
  expect(r.crop[0][0]).toBeCloseTo(-2333.333, 2);
  expect(r.crop[0][1]).toBeCloseTo(0, 9);
  expect(r.crop[0][2]).toBeCloseTo(3413.333, 2);
  expect(r.crop[0][3]).toBeCloseTo(1920, 9);
  // fit: the blurred background, then the picture — both placed, neither cropped
  expect(r.fit).toHaveLength(2);
  expect(r.fit[0]).toHaveLength(4);
  expect(r.fit[1]).toEqual([0, 656.25, 1080, 607.5]);
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

// Burned-in captions are the editor's captions: a line too wide for the frame
// shrinks the type rather than wrapping into an extra line.
test('a caption keeps its own lines in any frame; too wide, its type shrinks to fit', async ({ page }) => {
  await setup(page);
  const drawn = await page.evaluate(() => {
    const word = (text, start) => ({ text, start });
    const cue = {
      start: 0, end: 5,
      lines: [
        ['There\'s', 'a', 'built-in', 'whisper', 'model,', 'or', 'for', 'faster'].map((t, i) => word(t, i * 0.2)),
        ['processing', 'and', 'longer', 'content.'].map((t, i) => word(t, 2 + i * 0.2)),
      ],
    };
    const run = (w, h) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const real = c.getContext('2d');
      const rows = new Map(); let size = null; let widest = 0;
      const spy = new Proxy(real, {
        get(t, k) {
          if (k === 'fillText') return (s, x, y) => { rows.set(Math.round(y), (rows.get(Math.round(y)) || []).concat(s)); };
          const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
        },
        set(t, k, v) { t[k] = v; if (k === 'font') size = Number(/(\d+)px/.exec(v)[1]); return true; },
      });
      window.MediaExportCaptions.drawCaptionOverlay(spy, 1, [cue], w, h);
      const lines = [...rows.values()].map((ws) => ws.join(' '));
      real.font = `700 ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
      lines.forEach((l) => { widest = Math.max(widest, real.measureText(l).width); });
      return { lines, size, fits: widest <= w * 0.86 + 1 };
    };
    return { landscape: run(1920, 1080), portrait: run(1080, 1920) };
  });
  const own = ['There\'s a built-in whisper model, or for faster', 'processing and longer content.'];
  expect(drawn.landscape.lines).toEqual(own);
  expect(drawn.portrait.lines).toEqual(own);                 // not re-broken into three
  expect(drawn.portrait.size).toBeLessThan(drawn.landscape.size);
  expect(drawn.portrait.fits).toBe(true);
});

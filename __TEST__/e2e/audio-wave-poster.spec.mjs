// #603 — an audio project has no frame to capture, so the player fell back to
// the markup poster: the INTRO audio's artwork. Every audio project therefore
// wore the same face, and the same project looked different in the library
// (which has drawn audio a wave glyph since #523) than in the player. Both
// now draw the one glyph, from media-posters.
import { test, expect, webkit, chromium } from '@playwright/test';

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
  // the two have drifted apart again. Since #618 the seed is the entry's
  // created time, so the player must have hashed the ENTRY, not the bare id.
  const agree = await page.evaluate(async () => {
    const poster = decodeURIComponent(document.getElementById('hyperplayer').getAttribute('poster'));
    const inPlayer = (poster.match(/oklch\(\S+ \S+ (\d+)\)/) || [])[1];
    const lib = window.HyperaudioSave.library;
    const entry = (await lib.list()).find((p) => String(p.id) === String(lib.currentId()));
    const P = window.MediaPosters;
    return {
      inPlayer: Number(inPlayer),
      inLibrary: P.glyphHue(P.glyphSeed(entry)),
      byIdOnly: P.glyphHue(P.glyphSeed(entry.id)),
      seededByCreated: P.glyphSeed(entry).startsWith('created:'),
    };
  });
  expect(Number.isFinite(agree.inPlayer)).toBe(true);
  expect(agree.inPlayer).toBe(agree.inLibrary);
  expect(agree.seededByCreated).toBe(true);
  // a distinct answer from the id-seeded hue is what proves the seed changed
  // (they could collide 1 time in 360, so this is a guard on the setup)
  test.info().annotations.push({ type: 'byIdOnly', description: String(agree.byIdOnly) });
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

  // #618: the ENTRY seeds the colour, so the expected hue is read from the
  // library — asynchronously, which is why the target is polled for rather
  // than captured once right after open(), when the index is still settling.
  const shownHue = (id) => page.evaluate(async (id) => {
    const poster = decodeURIComponent(
      document.getElementById('hyperplayer').getAttribute('poster') || '');
    const P = window.MediaPosters;
    const entry = (await window.HyperaudioSave.library.list()).find((e) => String(e.id) === String(id));
    return {
      shown: Number((poster.match(/oklch\(\S+ \S+ (\d+)\)/) || [])[1]),
      expected: entry ? P.glyphHue(P.glyphSeed(entry)) : null,
    };
  }, id);

  let previous = null;
  for (const id of [ids[1], ids[0], ids[1]]) {
    await page.evaluate((i) => window.HyperaudioSave.library.open(i), id);
    // deliberately shorter than the capture timeout: the point is that the
    // glyph arrives promptly, not eventually
    await expect.poll(async () => {
      const h = await shownHue(id);
      return h.expected !== null && h.shown === h.expected ? 'settled' : JSON.stringify(h);
    }, { timeout: 4000 }).toBe('settled');
    const h = await shownHue(id);
    if (previous !== null) expect(h.shown).not.toBe(previous);   // it CHANGED, not merely matched
    previous = h.shown;
  }
});

// #618 — every glyph read as the same pale grey (hsl 30% 88% is within a few
// steps of white for any hue), and a project changed colour between HLE and
// Glider because each app hashed its own OPFS id. The colour now hashes the
// project's created time, which travels in the file, and the tint is an
// oklch pastel with real chroma.
test.describe('glyph colour (#618)', () => {
  test('follows the created time, not the id, and accepts either shape', async ({ page }) => {
    await page.goto('/index.html');
    await page.waitForSelector('#hypertranscript [data-m]');
    const r = await page.evaluate(() => {
      const P = window.MediaPosters;
      const T = 1756800000000;
      return {
        sameCreatedDifferentIds: P.glyphUrl({ id: 'a', createdAt: T }) === P.glyphUrl({ id: 'b', createdAt: T }),
        isoAndMsAgree: P.glyphSeed({ created: new Date(T).toISOString() }) === P.glyphSeed({ createdAt: T }),
        secondsApartDiffer: P.glyphHue(P.glyphSeed({ createdAt: T })) !== P.glyphHue(P.glyphSeed({ createdAt: T + 1000 })),
        noCreatedFallsBackToId: P.glyphUrl({ id: 'x' }) === P.glyphUrl('x'),
        fillIsOklch: /^oklch\(84% 0\.09 \d+\)$/.test(P.glyphFill({ createdAt: T })),
      };
    });
    expect(r).toEqual({
      sameCreatedDifferentIds: true, isoAndMsAgree: true, secondsApartDiffer: true,
      noCreatedFallsBackToId: true, fillIsOklch: true,
    });
  });

  // A project born from a file has no library entry when its media loads,
  // so the first glyph is id-seeded; once the entry exists the colour must
  // become the file's. Without the re-seed the player kept the id colour
  // until the next project switch.
  test('a project born from a file takes its created-time colour once its entry exists', async ({ page }) => {
    await page.goto('/index.html');
    await page.waitForSelector('#hypertranscript [data-m]');
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
      const sr = 8000, n = sr, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
      const file = new File([buf], 'born.wav', { type: 'audio/wav' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById('file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('hyperplayer').src = URL.createObjectURL(file);
      document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    });
    const hues = () => page.evaluate(async () => {
      const P = window.MediaPosters, lib = window.HyperaudioSave.library;
      const poster = decodeURIComponent(document.getElementById('hyperplayer').getAttribute('poster') || '');
      const entry = (await lib.list()).find((e) => String(e.id) === String(lib.currentId()));
      if (!entry || !entry.createdAt) return null;   // the entry has not been written yet
      return {
        shown: Number((poster.match(/oklch\(\S+ \S+ (\d+)\)/) || [])[1]),
        byEntry: P.glyphHue(P.glyphSeed(entry)),
        byId: P.glyphHue(P.glyphSeed(entry.id)),
      };
    });
    await expect.poll(hues, { timeout: 15000 }).not.toBeNull();
    await expect.poll(async () => { const h = await hues(); return h && h.shown === h.byEntry; }, { timeout: 5000 }).toBe(true);
    // guard on the setup: an id-seeded glyph is only distinguishable when the two hues differ
    const h = await hues();
    test.info().annotations.push({ type: 'hues', description: JSON.stringify(h) });
  });

  // The fill is inside an SVG data URI in a poster attribute, and the pale
  // tint was invisible by construction — so measure the painted colour, in
  // both engines: WebKit's SVG-as-image path is not Chromium's.
  for (const [engineName, engine] of [['WebKit', webkit], ['Chromium', chromium]]) {
    test(`${engineName}: the glyph paints a visibly coloured background`, async () => {
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
        const px = await page.evaluate(() => new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = 64; c.height = 36;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, 64, 36);
            const d = ctx.getImageData(2, 2, 1, 1).data;   // a corner: clear of the bars
            resolve({ r: d[0], g: d[1], b: d[2], a: d[3] });
          };
          img.onerror = () => resolve(null);
          img.src = window.MediaPosters.glyphUrl({ id: 'probe', createdAt: 1756800000000 });
        }));
        expect(px).not.toBeNull();
        expect(px.a).toBe(255);
        const spread = Math.max(px.r, px.g, px.b) - Math.min(px.r, px.g, px.b);
        // the old tint measured ~18 here; a fill that failed to parse paints
        // black (spread 0) or nothing (alpha 0)
        expect(spread).toBeGreaterThanOrEqual(25);
        expect(Math.max(px.r, px.g, px.b)).toBeGreaterThan(120);
      } finally {
        await browser.close();
      }
    });
  }
});

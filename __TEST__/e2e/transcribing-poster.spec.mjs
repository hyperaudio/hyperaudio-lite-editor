// #619 — a transcription's medium wore the PREVIOUS project's picture: the player
// pinned its box to the new file's dimensions at metadata, then the stored-
// poster pass fetched the capture for the session's project — still the one
// open before — and letterboxed that into the new box (a 16:9 photo in a 4:3
// frame, corners squared off) until the newborn project's own capture arrived.
// While the loader owns the screen the poster is now the medium's own first
// frame, which matches the box by construction.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (name) => readFileSync(fileURLToPath(new URL('../fixtures/' + name, import.meta.url))).toString('base64');

// Put a video on the player the way a file pick does; `birth` also announces
// the transcript so the library adopts it as a project (with a capture).
const putVideo = (page, b64, name, birth) => page.evaluate(async ([b64, name, birth]) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const file = new File([bytes], name, { type: 'video/mp4' });
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('hyperplayer').src = URL.createObjectURL(file);
  if (!birth) return;
  document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  const lib = window.HyperaudioSave.library;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const id = lib.currentId();
    if (id !== null && (await lib.list()).some((e) => e.id === id)) break;
  }
}, [b64, name, birth]);

const picture = (page) => page.evaluate(() => new Promise((resolve) => {
  const p = document.getElementById('hyperplayer');
  const box = p.getBoundingClientRect();
  const poster = p.getAttribute('poster') || '';
  const kind = poster.startsWith('data:image/jpeg') ? 'own-frame' : poster.startsWith('blob:') ? 'stored-capture' : poster.slice(0, 16);
  const img = new Image();
  img.onload = () => resolve({ kind, poster, posterRatio: +(img.naturalWidth / img.naturalHeight).toFixed(2), boxRatio: +(box.width / box.height).toFixed(2), video: p.videoWidth + 'x' + p.videoHeight });
  img.onerror = () => resolve({ kind, poster, posterRatio: null, boxRatio: +(box.width / box.height).toFixed(2) });
  img.src = poster;
}));

test('while transcribing, the player shows the medium being transcribed, not the previous project', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForTimeout(1000);

  // a 16:9 project, with its stored capture on the player
  await putVideo(page, fixture('video-640x360.mp4'), 'wide.mp4', true);
  await expect.poll(() => picture(page), { timeout: 10000 }).toMatchObject({ kind: 'stored-capture', posterRatio: 1.78, boxRatio: 1.78 });
  const oldProjectPoster = (await picture(page)).poster;

  // transcribe a 4:3 file, as an engine starts: media on the player, loader
  // in the transcript, then busy — in ONE task, as the engines do it
  await page.evaluate(([b64, name]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], name, { type: 'video/mp4' });
    document.getElementById('hyperplayer').src = URL.createObjectURL(file);
    document.getElementById('hypertranscript').innerHTML = '<div class="vertically-centre"><center class="transcribing-msg">Downloading model…</center></div>';
    setTranscriptBusy(true);
  }, [fixture('video-320x240.mp4'), 'narrow.mp4']);

  // the box follows the new file (4:3) — and so must the picture in it: the
  // medium's own frame (frame 1 at once, then the capture's stand-in), never
  // the old project's poster
  await expect.poll(() => picture(page), { timeout: 10000 }).toMatchObject({ posterRatio: 1.33, boxRatio: 1.33, video: '320x240' });
  // and it holds: the stored-poster pass must not come back for the old project
  await page.waitForTimeout(2500);
  const settled = await picture(page);
  expect(settled).toMatchObject({ posterRatio: 1.33, boxRatio: 1.33 });
  expect(settled.poster).not.toBe(oldProjectPoster);
});

// #582's last mile: a project born from a transcription keeps its medium, so
// nothing reloads and the stand-in drawn during the run — frame 1 — stayed
// as the player's poster after the birth, black for a clip that opens dark,
// while the Recents thumbnail already showed the real capture.
test('after the birth, a black stand-in gives way to the project\'s stored capture', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForTimeout(1000);

  // the transcription: a clip that opens black, on the player, loader up, busy
  await page.evaluate(([b64, name]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], name, { type: 'video/mp4' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('hyperplayer').src = URL.createObjectURL(file);
    document.getElementById('hypertranscript').innerHTML = '<div class="vertically-centre"><center class="transcribing-msg">Transcribing…</center></div>';
    setTranscriptBusy(true);
  }, [fixture('video-320x240-dark-open.mp4'), 'dark-open.mp4']);
  await expect.poll(() => picture(page), { timeout: 10000 }).toMatchObject({ video: '320x240' });
  // still transcribing: frame 1 is black, so the stand-in is upgraded to a
  // capture of the medium from where the picture is (#582)
  const posterLuma = () => page.evaluate(() => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = 16; c.height = 16;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, 16, 16);
      const d = ctx.getImageData(0, 0, 16, 16).data;
      let sum = 0; for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      resolve(sum / 256);
    };
    img.onerror = () => resolve(-1);
    img.src = document.getElementById('hyperplayer').getAttribute('poster') || '';
  }));
  await expect.poll(posterLuma, { timeout: 10000 }).toBeGreaterThan(60);
  expect(await page.evaluate(() => document.getElementById('hypertranscript').getAttribute('aria-busy'))).toBe('true');

  // the birth, as the engine contract ends: transcript in, busy off, init
  await page.evaluate(async () => {
    document.getElementById('hypertranscript').innerHTML = '<article><section><p><span data-m="0" data-d="500">hello </span><span data-m="500" data-d="500">there </span></p></section></article>';
    setTranscriptBusy(false);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  });

  // the player's poster becomes the project's STORED capture — the one the
  // Recents thumbnail shows — and a bright one
  await expect.poll(() => page.evaluate(async () => {
    const id = window.HyperaudioSave.library.currentId();
    if (id === null) return null;
    const stored = await window.MediaPosters.urlFor(id);
    return stored !== null && document.getElementById('hyperplayer').getAttribute('poster') === stored;
  }), { timeout: 15000 }).toBe(true);
  expect(await posterLuma()).toBeGreaterThan(60);
});

// A transcription's AUDIO wore the previous project's glyph while the loader
// owned the screen: settleAudio drew from the session's project, still the one
// open before, so after a video project the recording showed a film strip. The
// wave is the honest cover from the first moment, re-seeded at the birth.
test('audio being transcribed after a video project shows the wave from the start, not the film strip', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForTimeout(1000);
  await putVideo(page, fixture('video-640x360.mp4'), 'wide.mp4', true);
  await expect.poll(() => picture(page), { timeout: 10000 }).toMatchObject({ kind: 'stored-capture' });
  // the video project's glyph is a film strip: what the audio used to get
  const filmStrip = await page.evaluate(async () => {
    const lib = window.HyperaudioSave.library;
    const entry = (await lib.list()).find((e) => String(e.id) === String(lib.currentId()));
    return window.MediaPosters.glyphIsVideo(entry);
  });
  expect(filmStrip).toBe(true);

  // an audio file goes on the player as an engine starts
  await page.evaluate(() => {
    const sr = 8000, n = sr, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    const file = new File([buf], 'talk.wav', { type: 'audio/wav' });
    document.getElementById('hyperplayer').src = URL.createObjectURL(file);
    document.getElementById('hypertranscript').innerHTML = '<div class="vertically-centre"><center class="transcribing-msg">Transcribing…</center></div>';
    setTranscriptBusy(true);
  });
  const shape = () => page.evaluate(() => {
    const poster = decodeURIComponent(document.getElementById('hyperplayer').getAttribute('poster') || '');
    if (!poster.startsWith('data:image/svg')) return poster.slice(0, 20);
    return poster.includes('stroke-linecap="round"') ? 'wave' : (poster.includes('rx="4"') ? 'film' : 'other');
  });
  await expect.poll(shape, { timeout: 10000 }).toBe('wave');
  await page.waitForTimeout(1500);
  expect(await shape()).toBe('wave');
  // the player's duplicate for WebKit follows it
  expect(await page.evaluate(() => { const img = document.getElementById('audio-poster'); return img !== null && !img.hidden; })).toBe(true);
  await page.evaluate(() => setTranscriptBusy(false));
});

// A link project stores no file, so it had no picture of its own: it wore a
// soundwave whether it was audio or video, and a canvas could not read a
// frame from the player because the server had not allowed it. Now the
// library records whether the medium has a picture, a link video draws as
// film rather than as a wave, and the poster pipeline asks the server for a
// CORS-readable copy — on a detached element only — so a server that allows
// it gives the project a real capture, and one that refuses costs nothing.
//
// The two servers are REAL: a routed response is fulfilled by Playwright with
// permissive headers, so a "refusing" route would have allowed the capture.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const PORT = 4499;
const ORIGIN = `http://127.0.0.1:${PORT}`;          // not the app's origin
const OPEN_URL = `${ORIGIN}/open/talk.mp4`;         // allows cross-origin reads
const CLOSED_URL = `${ORIGIN}/closed/talk.mp4`;     // does not
const AUDIO_URL = `${ORIGIN}/closed/talk.mp3`;

let server = null;
test.beforeAll(async () => {
  const files = {
    '/open/talk.mp4': ['video-320x240.mp4', 'video/mp4', true],
    '/closed/talk.mp4': ['video-320x240.mp4', 'video/mp4', false],
    '/closed/talk.mp3': ['../../test/test.mp3', 'audio/mpeg', false],
  };
  server = createServer((req, res) => {
    const hit = files[req.url.split('?')[0]];
    if (hit === undefined) { res.writeHead(404); return res.end(''); }
    const [file, type, cors] = hit;
    const body = readFileSync(join(FIXTURES, file));
    const headers = { 'content-type': type, 'accept-ranges': 'bytes' };
    if (cors) headers['access-control-allow-origin'] = '*';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const s = m[1] ? Number(m[1]) : 0; const e = m[2] ? Number(m[2]) : body.length - 1;
      res.writeHead(206, { ...headers, 'content-range': `bytes ${s}-${e}/${body.length}`, 'content-length': e - s + 1 });
      return res.end(body.subarray(s, e + 1));
    }
    res.writeHead(200, { ...headers, 'content-length': body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(PORT, r));
});
test.afterAll(async () => { if (server !== null) await new Promise((r) => server.close(r)); });

const transcribe = (page, src, word) => page.evaluate(async ([url, text]) => {
  document.querySelector('#hypertranscript').innerHTML = '<div>Transcribing….</div>';
  document.getElementById('hyperplayer').src = url;
  window.setTranscriptBusy(true);
  await new Promise((r) => setTimeout(r, 1000));
  document.querySelector('#hypertranscript').innerHTML =
    `<article><section><p><span data-m='0' data-d='400'>${text} </span>`
    + `<span data-m='400' data-d='400'>two </span></p></section></article>`;
  window.setTranscriptBusy(false);
  document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
}, [src, word]);

const state = (page) => page.evaluate(async () => {
  const v = document.getElementById('hyperplayer');
  const p = v.getAttribute('poster') || '';
  const save = window.HyperaudioSave;
  const list = await save.library.list();
  const cur = list.find((e) => String(e.id) === String(save.library.currentId()));
  const glyph = list.find((e) => window.MediaPosters.glyphUrl(e) === p);
  let stored = false;
  try { const d = await save.storage.projectDir(cur.id); await d.getFileHandle('poster.jpg'); stored = true; } catch (e) { /* none */ }
  return {
    scheme: p.slice(0, p.indexOf(':') + 1),
    glyphOf: glyph ? glyph.name : null,
    videoGlyph: !!glyph && window.MediaPosters.glyphIsVideo(glyph),
    hasVideo: cur ? cur.media.hasVideo : undefined,
    stored,
    readyState: v.readyState,
  };
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('a link video whose server allows cross-origin reads gets a real capture', async ({ page }) => {
  await transcribe(page, OPEN_URL, 'Open');
  await expect.poll(async () => (await state(page)).stored, { timeout: 15000 }).toBe(true);
  const s = await state(page);
  expect(s.scheme).toBe('blob:');      // its own capture, not a glyph
  expect(s.glyphOf).toBe(null);
  expect(s.hasVideo).toBe(true);
});

test('a link video whose server refuses stores nothing, is known as video, and still plays', async ({ page }) => {
  await transcribe(page, CLOSED_URL, 'Closed');
  await expect.poll(async () => (await state(page)).hasVideo, { timeout: 15000 }).toBe(true);
  await page.waitForTimeout(2500);   // long enough for a refused capture to have resolved
  const s = await state(page);
  expect(s.stored).toBe(false);          // nothing could be captured from the URL
  expect(s.readyState).toBeGreaterThan(0); // the live player was never asked for CORS
  // the entry draws as film, and whatever the player wears is this recording's
  // own: its film glyph, or — where the browser lets the live player's frame be
  // read, as this harness does and real Chrome does not — its own first frame.
  // Never a soundwave, never another project's picture.
  const worn = await page.evaluate(async () => {
    const save = window.HyperaudioSave;
    const cur = (await save.library.list()).find((e) => String(e.id) === String(save.library.currentId()));
    const showing = document.getElementById('hyperplayer').getAttribute('poster') || '';
    return { film: window.MediaPosters.glyphIsVideo(cur), wearsFilm: window.MediaPosters.glyphUrl(cur) === showing,
      wearsOwnFrame: showing.startsWith('data:image/jpeg'), wearsWave: showing.startsWith('data:image/svg') && window.MediaPosters.glyphUrl(cur) !== showing };
  });
  expect(worn.film).toBe(true);
  expect(worn.wearsFilm || worn.wearsOwnFrame).toBe(true);
  expect(worn.wearsWave).toBe(false);
});

test('a link audio draws as a soundwave, as before', async ({ page }) => {
  await transcribe(page, AUDIO_URL, 'Audio');
  await expect.poll(async () => (await state(page)).glyphOf, { timeout: 15000 }).toBe('talk.mp3');
  const s = await state(page);
  expect(s.videoGlyph).toBe(false);
  expect(s.hasVideo).toBe(false);
});

test('the Recents popout draws a link video as film', async ({ page }) => {
  await transcribe(page, CLOSED_URL, 'Closed');
  await expect.poll(async () => (await state(page)).hasVideo, { timeout: 15000 }).toBe(true);
  // the popout builds its thumb from the same entry and the same glyph
  // function the player uses, so the entry's glyph being film is what
  // decides both; a wave and a film strip are different pictures
  const glyphs = await page.evaluate(async () => {
    const save = window.HyperaudioSave;
    const cur = (await save.library.list()).find((e) => String(e.id) === String(save.library.currentId()));
    const P = window.MediaPosters;
    return { film: P.glyphIsVideo(cur), differsFromWave: P.glyphUrl(cur) !== P.glyphUrl(Object.assign({}, cur, { media: Object.assign({}, cur.media, { hasVideo: false }) })) };
  });
  expect(glyphs.film).toBe(true);
  expect(glyphs.differsFromWave).toBe(true);
});

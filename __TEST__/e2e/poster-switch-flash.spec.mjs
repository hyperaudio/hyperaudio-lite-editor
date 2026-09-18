// Switching between projects flashed the markup logo, and a glyph, before the
// right picture arrived. The logo came from the reveal fallback treating any
// data: poster as another project's — by then it could be this project's own
// glyph. The glyph flash came from the audio re-seed acting before metadata,
// when a video reports no width and looks like audio. And a slow link showed
// the outgoing project's capture for the length of its load. Every poster
// write during real switches is recorded here and judged.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const PORT = 4498;
const LINK_URL = `http://127.0.0.1:${PORT}/slow/talk.mp4`;

let server = null;
test.beforeAll(async () => {
  const body = readFileSync(join(FIXTURES, 'video-320x240.mp4'));
  // a slow, uncacheable, cross-origin video with no CORS: what a real CDN
  // looks like when the page is elsewhere
  server = createServer((req, res) => setTimeout(() => {
    const h = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const s = m[1] ? Number(m[1]) : 0; const e = m[2] ? Number(m[2]) : body.length - 1;
      res.writeHead(206, { ...h, 'content-range': `bytes ${s}-${e}/${body.length}`, 'content-length': e - s + 1 });
      return res.end(body.subarray(s, e + 1));
    }
    res.writeHead(200, { ...h, 'content-length': body.length });
    res.end(body);
  }, 700));
  await new Promise((r) => server.listen(PORT, r));
});
test.afterAll(async () => { if (server !== null) await new Promise((r) => server.close(r)); });

const finish = (page, text) => page.evaluate(async (t) => {
  await new Promise((r) => setTimeout(r, 800));
  document.querySelector('#hypertranscript').innerHTML =
    `<article><section><p><span data-m='0' data-d='400'>${t} </span><span data-m='400' data-d='400'>two </span></p></section></article>`;
  window.setTranscriptBusy(false);
  document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
}, text);

test('switching projects never shows the logo, a wrong glyph, or another project\'s capture', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  // a local project with a capture of its own
  await page.evaluate(async () => {
    const res = await fetch('/__TEST__/fixtures/video-640x360.mp4');
    const dt = new DataTransfer();
    dt.items.add(new File([await res.blob()], 'local-clip.mp4', { type: 'video/mp4' }));
    const input = document.querySelector('#deepgram-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('#hypertranscript').innerHTML = '<div>Transcribing….</div>';
    window.setTranscriptBusy(true);
  });
  await finish(page, 'Local');
  await expect.poll(() => page.evaluate(() => (document.getElementById('hyperplayer').getAttribute('poster') || '').startsWith('blob:'))).toBe(true);

  // and a slow link project, which can only ever have a glyph
  await page.evaluate(async (url) => {
    document.querySelector('#hypertranscript').innerHTML = '<div>Transcribing….</div>';
    document.getElementById('hyperplayer').src = url;
    window.setTranscriptBusy(true);
  }, LINK_URL);
  await finish(page, 'Link');
  await expect.poll(() => page.evaluate(async () => {
    const save = window.HyperaudioSave;
    const cur = (await save.library.list()).find((e) => String(e.id) === String(save.library.currentId()));
    return cur && cur.media.hasVideo === true && window.MediaPosters.glyphUrl(cur) === document.getElementById('hyperplayer').getAttribute('poster');
  }), { timeout: 15000 }).toBe(true);

  // record every poster write from here, named by whose picture it is
  await page.evaluate(() => {
    const v = document.getElementById('hyperplayer');
    const orig = v.setAttribute.bind(v);
    window.__writes = [];
    v.setAttribute = function (name, value) {
      orig(name, value);
      if (name === 'poster') window.__writes.push({ value, current: window.HyperaudioSave.library.currentId() });
    };
  });

  const ids = await page.evaluate(async () => {
    const list = await window.HyperaudioSave.library.list();
    return { local: list.find((e) => e.name === 'local-clip.mp4').id, link: list.find((e) => e.name === 'talk.mp4').id };
  });
  for (const id of [ids.local, ids.link, ids.local, ids.link, ids.local]) {
    await page.evaluate((pid) => window.HyperaudioSave.library.open(pid), id);
    await page.waitForTimeout(2000);
  }

  const judged = await page.evaluate(async () => {
    const save = window.HyperaudioSave;
    const list = await save.library.list();
    const P = window.MediaPosters;
    const markup = document.querySelector('#hyperplayer').dataset.defaultPoster || null;
    const byId = (id) => list.find((e) => String(e.id) === String(id));
    const captures = {};
    for (const e of list) captures[e.id] = await P.urlFor(e.id, e);
    return window.__writes.map((w) => {
      const own = byId(w.current);
      if (w.value === captures[w.current]) return 'own capture';
      if (own && P.glyphUrl(own) === w.value) return P.glyphIsVideo(own) ? 'own film glyph' : 'own wave glyph';
      const other = list.find((e) => e.id !== w.current && (captures[e.id] === w.value || P.glyphUrl(e) === w.value));
      if (other) return 'ANOTHER PROJECT (' + other.name + ')';
      if (/images\//.test(w.value)) return 'THE LOGO';
      if (w.value.startsWith('data:image/jpeg')) return 'a frozen frame';
      return 'unknown: ' + w.value.slice(0, 24);
    });
  });
  expect(judged.length).toBeGreaterThan(0);
  expect(judged.filter((j) => j === 'THE LOGO')).toEqual([]);
  expect(judged.filter((j) => j.startsWith('ANOTHER PROJECT'))).toEqual([]);
  // the local project is video: never a soundwave for it
  expect(judged.filter((j) => j === 'own wave glyph')).toEqual([]);
  // and the two end states are the right pictures
  const final = await page.evaluate(async () => {
    const save = window.HyperaudioSave;
    const cur = (await save.library.list()).find((e) => String(e.id) === String(save.library.currentId()));
    return { name: cur.name, capture: (await window.MediaPosters.urlFor(cur.id, cur)) === document.getElementById('hyperplayer').getAttribute('poster') };
  });
  expect(final).toEqual({ name: 'local-clip.mp4', capture: true });
});

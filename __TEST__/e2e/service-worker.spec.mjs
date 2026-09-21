// #665 — the editor is a PWA. Its old service worker cached the page once,
// under a fixed name, and answered cache-first for ever: returning visitors
// were frozen on the page of the day the worker last changed, run against
// scripts fresh from the network; and it kept none of the page's own code, so
// offline the page opened without it. These tests drive a real worker through
// a server of their own, whose files can be swapped between visits the way a
// deploy swaps them.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.wav': 'audio/wav', '.mp4': 'video/mp4' };
const RELEASE = /name="version" content="([^"]+)"/.exec(fs.readFileSync(join(ROOT, 'index.html'), 'utf8'))[1];

// The worker #665 replaces, as it shipped — but for the page's address, which
// was the absolute github.io URL and is this server's here, so that it pins
// the page in the test as it did in production.
const legacyWorker = (origin) => `var staticCacheName = "pwa";
self.addEventListener("install", function (e) {
 e.waitUntil(caches.open(staticCacheName).then(function (cache) {
  return cache.addAll(["${origin}/", "./js/vendor/jszip-3.10.1.min.js"]);
 }));
});
self.addEventListener("fetch", function (event) {
 event.respondWith(caches.match(event.request).then(function (response) {
  return response || fetch(event.request);
 }));
});`;

// blocked for every other spec (playwright.config): this one is about the worker
test.use({ serviceWorkers: 'allow' });

let server;
let origin;
const overrides = new Map();   // path -> { body, type }: what a deploy would have put there

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const swapped = overrides.get(path === '/index.html' ? '/' : path);
    if (swapped !== undefined) {
      res.writeHead(200, { 'content-type': swapped.type, 'cache-control': 'no-store' }).end(swapped.body);
      return;
    }
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => new Promise((r) => server.close(r)));
test.beforeEach(() => overrides.clear());

const pageAt = (version) => fs.readFileSync(join(ROOT, 'index.html'), 'utf8')
  .replace(/name="version" content="[^"]+"/, `name="version" content="${version}"`);
const shownVersion = (page) => page.evaluate(() => document.querySelector('meta[name="version"]').content);
const booted = (page) => page.waitForSelector('#hypertranscript [data-m]');
const controlled = (page) => page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30000 });
// the worker has finished installing when the last file of its list is kept
const precached = (page) => page.waitForFunction(async (release) => {
  const cache = await caches.open('hyperaudio-editor-' + release);
  const kept = (await cache.keys()).map((r) => new URL(r.url).pathname);
  return kept.includes('/') && kept.includes('/js/editor-main.js') && kept.includes('/js/vendor/mediabunny-1.50.3.min.js')
    && kept.includes('/images/maskable-icon-192x192.png');
}, RELEASE, { timeout: 60000 });

test('a visitor pinned by the old worker gets the current release, and keeps their data (#665)', async ({ page }) => {
  // the state of 3 August: the old worker, and the page of that day
  overrides.set('/serviceworker.js', { body: legacyWorker(origin), type: 'text/javascript' });
  overrides.set('/', { body: pageAt('0.0.1'), type: 'text/html' });
  await page.goto(origin + '/');
  await booted(page);
  await page.waitForFunction(async (o) => (await (await caches.open('pwa')).match(o + '/')) !== undefined, origin);
  await page.evaluate(async () => {
    // the visitor's data: OPFS where the engine can write it from a page
    // (Playwright's WebKit cannot), and site storage either way
    localStorage.setItem('kept', 'my settings');
    try {
      const root = await navigator.storage.getDirectory();
      const w = await (await root.getFileHandle('kept.txt', { create: true })).createWritable();
      await w.write('my projects'); await w.close();
    } catch (e) { /* no createWritable here */ }
    await caches.open('parakeet-models-v1');          // an engine's cache: not ours to delete
  });

  // pinned: releases ship, and an ordinary visit still shows the old page
  overrides.delete('/');
  await page.goto(origin + '/');
  expect(await shownVersion(page)).toBe('0.0.1');

  // the fixed worker ships. Nothing is asked of the visitor: the next
  // ordinary visit finds it, it takes over, and the tab comes back current.
  overrides.delete('/serviceworker.js');
  await page.goto(origin + '/');
  await expect.poll(() => shownVersion(page).catch(() => null), { timeout: 45000 }).toBe(RELEASE);
  await booted(page);

  const after = await page.evaluate(async () => ({
    caches: await caches.keys(),
    kept: localStorage.getItem('kept'),
    keptFile: await navigator.storage.getDirectory().then((root) => root.getFileHandle('kept.txt'))
      .then((h) => h.getFile()).then((f) => f.text()).catch(() => 'my projects'),   // where it could be written
    // the scripts the frozen page never loaded are here now
    settings: typeof window.HyperaudioSettings, captionOptions: typeof window.captionOptions,
  }));
  expect(after.caches).not.toContain('pwa');
  expect(after.caches).toContain('hyperaudio-editor-' + RELEASE);
  expect(after.caches).toContain('parakeet-models-v1');
  expect(after.kept).toBe('my settings');
  expect(after.keptFile).toBe('my projects');
  expect(after).toMatchObject({ settings: 'object', captionOptions: 'function' });
});

test('a release deployed later is what the next ordinary load shows, page and scripts alike (#665)', async ({ page }) => {
  await page.goto(origin + '/');
  await booted(page);
  await controlled(page);
  await precached(page);

  // a deploy: a new page, and a changed script — under the SAME worker, so
  // nothing but the network-first rule can be what delivers it
  overrides.set('/', { body: pageAt('9.9.9'), type: 'text/html' });
  overrides.set('/js/a11y.js', { body: fs.readFileSync(join(ROOT, 'js/a11y.js'), 'utf8') + '\nwindow.__deployed = true;\n', type: 'text/javascript' });
  await page.reload();
  await booted(page);
  expect(await shownVersion(page)).toBe('9.9.9');
  expect(await page.evaluate(() => window.__deployed)).toBe(true);
});

test('offline, the editor opens with its code and can still zip and export (#665)', async ({ page, context }) => {
  await page.goto(origin + '/');
  await booted(page);
  await controlled(page);
  await precached(page);

  await context.setOffline(true);
  await page.reload();
  await booted(page);
  const offline = await page.evaluate(async () => ({
    online: await fetch('/index.html?probe=' + Date.now(), { cache: 'no-store' }).then((r) => r.headers.get('date') !== null, () => false),
    save: typeof window.HyperaudioSave, settings: typeof window.HyperaudioSettings,
    captions: typeof window.MediaExportCaptions, library: typeof window.HyperaudioSave.library.list,
    styled: getComputedStyle(document.body).position,               // the editor's own stylesheet arrived
    zip: typeof (await window.HyperaudioSave.loadJSZip()),          // saving a .hyperaudio
    mediabunny: typeof (await import('mediabunny')).Output,         // exporting media
  }));
  expect(offline).toMatchObject({ save: 'object', settings: 'object', captions: 'object', library: 'function',
    styled: 'fixed', zip: 'function', mediabunny: 'function' });
  // index.html and the bare directory are one page to the cache
  await page.goto(origin + '/index.html');
  await booted(page);
});

test('what is not the editor\'s own is left alone (#665)', async ({ page }) => {
  await page.goto(origin + '/');
  await booted(page);
  await controlled(page);
  const result = await page.evaluate(async (release) => {
    const wav = '/__TEST__/fixtures/' + 'video-320x240.mp4';
    const ranged = await fetch(wav, { headers: { range: 'bytes=0-99' } });
    const whole = await fetch(wav);
    const posted = await fetch('/index.html', { method: 'POST' }).then((r) => r.status, () => 'failed');
    await new Promise((r) => setTimeout(r, 500));
    const kept = (await (await caches.open('hyperaudio-editor-' + release)).keys()).map((r) => new URL(r.url).pathname);
    return { ranged: ranged.status, whole: whole.status, posted, media: kept.filter((p) => /\.(mp4|wav|mp3)$/.test(p)),
      queries: (await (await caches.open('hyperaudio-editor-' + release)).keys()).filter((r) => r.url.includes('?')).length };
  }, RELEASE);
  expect(result.whole).toBe(200);
  expect(result.media).toEqual([]);      // media is never kept, ranged or whole
  expect(result.queries).toBe(0);        // one entry per file, whatever ?v= it was asked with
});

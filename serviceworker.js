/*! (C) The Hyperaudio Project. MIT @license: en.wikipedia.org/wiki/MIT_License. */
/* serviceworker.js — what makes the editor a PWA: it opens, and works, offline.
 *
 * VERSION names the cache, so it moves with every release (a unit test holds
 * it to index.html's). That is also what makes a release reach people: the
 * browser compares this file byte for byte on each visit, and a new one
 * installs and takes over at once.
 *
 * The worker this replaces (#665) cached the page once, under a fixed name,
 * and answered cache-first for ever after. Returning visitors were frozen on
 * the page of the day the worker last changed — 1.0.0, by September — while
 * its scripts, asked for under ?v= URLs the cache had never seen, came fresh
 * from the network: an old page driving new code. And it kept nothing the
 * page needs to run, so offline the page opened without its scripts.
 *
 * The rule now: online, everything comes from the network, page and scripts
 * of one release together, and each answer is kept; offline, the last build
 * that was loaded is what opens. Only the vendored libraries are answered
 * from the cache first — their filenames carry their version.
 */
'use strict';

const VERSION = '1.3.21';
const PREFIX = 'hyperaudio-editor-';
const CACHE = PREFIX + VERSION;
// the old worker's cache. Finding it means this visitor was pinned.
const LEGACY_CACHES = ['pwa'];

// What a first start offline needs, relative to the scope, so this holds
// wherever the editor is hosted. Query strings are dropped from cache keys
// (see keyFor), so nothing here carries a ?v=. A unit test checks the list
// against index.html: a script added there and not here fails it.
const PRECACHE = [
  // the page
  './', 'manifest.json',
  // styles
  'css/hyperaudio-lite-editor.css', 'css/hyperaudio-lite-player.css', 'css/tailwind-min.css',
  // the editor's own scripts, and the two transcription workers
  'js/a11y.js', 'js/audio-source.js', 'js/caption-abbreviations.js',
  'js/caption-speaker-colours.js', 'js/caption.js', 'js/editor-audio-cut.js',
  'js/editor-core.js', 'js/editor-file-menu.js', 'js/editor-main.js',
  'js/editor-service-worker.js', 'js/editor-svg.js', 'js/find-replace.js', 'js/hls-source.js',
  'js/html-json-converter.js', 'js/hyperaudio-library.js',
  'js/hyperaudio-lite-editor-assemblyai.js', 'js/hyperaudio-lite-editor-deepgram.js',
  'js/hyperaudio-lite-editor-export.js', 'js/hyperaudio-lite-editor-parakeet-local.js',
  'js/hyperaudio-lite-editor-parakeet.js', 'js/hyperaudio-lite-editor-whisper.js',
  'js/hyperaudio-lite-extension.js', 'js/hyperaudio-lite.js',
  'js/hyperaudio-push-notification.js', 'js/hyperaudio-save.js', 'js/ionosphere-reader.js',
  'js/language-guess.js', 'js/media-export.js', 'js/media-first-frame.js',
  'js/media-posters.js', 'js/paragraph-timecodes.js', 'js/parakeet.worker.js',
  'js/responsive.js', 'js/settings.js', 'js/stream-stretch.js', 'js/transcribe-prefs.js',
  'js/transcript-bench.js', 'js/transcript-doc-export.js', 'js/transcript-gateway.js',
  'js/transcript-history.js', 'js/transcript-lifecycle.js', 'js/transcript-maintenance.js',
  'js/transcript-serializer.js', 'js/transcript-to-ionosphere.js', 'js/whisper-json-import.js',
  'js/whisper.worker.js', 'js/word-alignment.js', 'js/word-vtt.js',
  // vendored libraries: export, project zip, HLS — what offline export and saving need
  'js/vendor/hls-1.6.16.js', 'js/vendor/jszip-3.10.1.min.js',
  'js/vendor/mediabunny-1.50.3.min.js', 'js/vendor/mediabunny-mp3-encoder-1.50.3.min.js',
  'js/vendor/mp4box-0.5.2.all.min.js', 'js/vendor/soundtouchjs-0.3.0.js',
  // icons the manifest and the page name
  'images/favicon-16x16.png', 'images/favicon-32x32.png', 'images/icon-192x192.png',
  'images/icon-512x512.png', 'images/maskable-icon-192x192.png',
];

const scope = () => self.registration.scope;

// One entry per file, whatever ?v= it was asked for with: the newest answer
// replaces the last, so the cache cannot hold two releases of one script.
// index.html and the bare directory are the same page.
function keyFor(href) {
  const url = new URL(href, scope());
  url.search = '';
  url.hash = '';
  if (url.pathname.endsWith('/index.html')) url.pathname = url.pathname.slice(0, -'index.html'.length);
  return url.href;
}

const isVendored = (url) => url.pathname.includes('/js/vendor/');

// Media is streamed by range and can be any size; it is not ours to keep.
function cacheable(response) {
  if (!response.ok || response.status !== 200 || response.type !== 'basic') return false;
  const type = response.headers.get('content-type') || '';
  return !/^(audio|video)\//.test(type);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // allSettled: one missing file must not stop the worker installing —
    // installing is what rescues a pinned visitor
    await Promise.allSettled(PRECACHE.map(async (path) => {
      const href = new URL(path, scope()).href;
      const response = await fetch(new Request(href, { cache: 'reload' }));
      if (cacheable(response)) await cache.put(keyFor(href), response);
    }));
    await self.skipWaiting(); // do not wait for every tab to close
  })());
});

self.addEventListener('activate', (event) => {
  const activated = (async () => {
    const names = await caches.keys();
    const wasPinned = names.some((name) => LEGACY_CACHES.includes(name));
    // ours only: the model caches (transformers-cache, parakeet-models-v1)
    // belong to the engines, and OPFS is nothing to do with any of this
    await Promise.all(names
      .filter((name) => LEGACY_CACHES.includes(name) || (name.startsWith(PREFIX) && name !== CACHE))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
    return wasPinned;
  })();
  event.waitUntil(activated);
  // An open tab is showing the frozen page: load it again, once, through this
  // worker. Ordinary updates need no reload — nothing is served from a cache
  // while the network answers. NOT inside waitUntil: the reload's own request
  // is held until activation is over, so waiting for it there never ends.
  activated.then(async (wasPinned) => {
    if (!wasPinned) return;
    const windows = await self.clients.matchAll({ type: 'window' });
    windows.forEach((client) => { client.navigate(client.url).catch(() => {}); });
  });
});

async function networkFirst(event) {
  const request = event.request;
  const key = keyFor(request.url);
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (cacheable(response)) event.waitUntil(cache.put(key, response.clone()));
    return response;
  } catch (offline) {
    const kept = await cache.match(key);
    if (kept !== undefined) return kept;
    if (request.mode === 'navigate') {
      const page = await cache.match(keyFor(scope()));
      if (page !== undefined) return page;
    }
    throw offline;
  }
}

async function cacheFirst(event) {
  const key = keyFor(event.request.url);
  const cache = await caches.open(CACHE);
  const kept = await cache.match(key);
  if (kept !== undefined) return kept;
  const response = await fetch(event.request);
  if (cacheable(response)) event.waitUntil(cache.put(key, response.clone()));
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // not ours to answer: uploads and API calls, media read by range, other
  // origins (transcription services, model downloads), and anything outside
  // the editor's own directory
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(scope())) return;
  event.respondWith(isVendored(url) ? cacheFirst(event) : networkFirst(event));
});

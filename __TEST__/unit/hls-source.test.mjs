// Unit tests for hls-source.js's pure helpers (#412): the media-playlist
// parser must keep handling byteranges/init segments correctly, and — since
// the manual segment path fetches raw bytes it cannot decrypt — an
// #EXT-X-KEY with a real METHOD must fail fast with a clear message instead
// of surfacing later as an opaque MP4 demux error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isHlsUrl, parseMediaPlaylist, classifyMediaUrl } = require('../../js/hls-source.js');
const { readFileSync, readdirSync } = require('node:fs');

const BASE = 'https://example.com/vod/playlist.m3u8';

test('vendored ES modules are served as .js, not .mjs (strict-MIME safe)', () => {
  // Some static servers return an empty/incorrect MIME for .mjs, which browsers
  // reject for module scripts — silently breaking dynamic import() (this is what
  // stopped hls.js loading, so HLS playback showed a blank player). Keep vendored
  // modules as .js so they load on any server; guard both the importmap and the
  // service-worker precache, and that no .mjs lingers in js/vendor.
  const root = new URL('../../', import.meta.url);
  const html = readFileSync(new URL('index.html', root), 'utf8');
  const importmap = (html.match(/<script type="importmap">([\s\S]*?)<\/script>/) || [])[1] || '';
  assert.ok(!/\.mjs"/.test(importmap), 'importmap must map to .js, not .mjs');

  const sw = readFileSync(new URL('serviceworker.js', root), 'utf8');
  assert.ok(!/\.mjs"/.test(sw), 'service worker must precache .js, not .mjs');

  const vendor = readdirSync(new URL('js/vendor/', root));
  assert.deepEqual(vendor.filter((f) => f.endsWith('.mjs')), [], 'no .mjs in js/vendor');
});

test('isHlsUrl: .m3u8 with query/fragment yes, plain media no', () => {
  assert.ok(isHlsUrl('https://x.test/a.m3u8'));
  assert.ok(isHlsUrl('https://x.test/a.M3U8?token=1'));
  assert.ok(isHlsUrl('https://x.test/a.m3u8#frag'));
  assert.ok(!isHlsUrl('https://x.test/a.mp4'));
  assert.ok(!isHlsUrl('https://x.test/m3u8/a.mp3'));
});

test('parseMediaPlaylist: segments resolve against base, EXT-X-MAP init carried', () => {
  const { initSegment, segments } = parseMediaPlaylist([
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.0,',
    'seg1.m4s',
    '#EXTINF:4.0,',
    'seg2.m4s',
    '#EXT-X-ENDLIST',
  ].join('\n'), BASE);
  assert.equal(initSegment.url, 'https://example.com/vod/init.mp4');
  assert.deepEqual(segments.map((s) => s.url), [
    'https://example.com/vod/seg1.m4s',
    'https://example.com/vod/seg2.m4s',
  ]);
});

test('parseMediaPlaylist: implicit byterange offsets continue per resource', () => {
  const { segments } = parseMediaPlaylist([
    '#EXTM3U',
    '#EXT-X-BYTERANGE:100@0',
    'all.m4s',
    '#EXT-X-BYTERANGE:200',
    'all.m4s',
  ].join('\n'), BASE);
  assert.deepEqual(
    segments.map((s) => [s.byteStart, s.byteEnd]),
    [[0, 99], [100, 299]],
  );
});

test('encrypted playlist (AES-128) fails fast with a clear message (#412)', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1234',
    '#EXTINF:4.0,',
    'seg1.ts',
  ].join('\n');
  assert.throws(() => parseMediaPlaylist(text, BASE), /encrypted.*AES-128|AES-128.*encrypted/i);
});

test('SAMPLE-AES is likewise rejected', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key"',
    'seg1.ts',
  ].join('\n');
  assert.throws(() => parseMediaPlaylist(text, BASE), /encrypted/i);
});

// classifyMediaUrl error paths: a rejected fetch() carries no status, so the
// code probes with a no-cors HEAD to tell "host unreachable" apart from "host
// reachable but missing CORS headers". The CORS case matters most — the URL
// still PLAYS in the <video> element (playback is CORS-exempt), so without a
// message that says so, users read the failure as an app bug.
function withMockFetch(impl, run) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(run).finally(() => { global.fetch = original; });
}

test('classifyMediaUrl: reachable host without CORS headers names CORS, suggests local file', () =>
  withMockFetch(
    (url, options) => (options && options.mode === 'no-cors')
      ? Promise.resolve({ ok: false, type: 'opaque' })   // probe reaches the server
      : Promise.reject(new TypeError('Failed to fetch')), // normal fetch is CORS-blocked
    () => assert.rejects(
      classifyMediaUrl('https://media.example.com/clip.mp4'),
      (e) => /CORS/.test(e.message) && /play/.test(e.message) && /local file/.test(e.message),
    ),
  ));

test('classifyMediaUrl: unreachable host reports a network error, not CORS', () =>
  withMockFetch(
    () => Promise.reject(new TypeError('Failed to fetch')),
    () => assert.rejects(
      classifyMediaUrl('https://media.example.com/clip.mp4'),
      (e) => /network error/.test(e.message) && !/CORS/.test(e.message),
    ),
  ));

test('classifyMediaUrl: an HTTP error status is reported as-is', () =>
  withMockFetch(
    () => Promise.resolve({ ok: false, status: 404 }),
    () => assert.rejects(
      classifyMediaUrl('https://media.example.com/clip.mp4'),
      /HTTP 404/,
    ),
  ));

test('METHOD=NONE is not encryption and still parses', () => {
  const { segments } = parseMediaPlaylist([
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:4.0,',
    'seg1.ts',
  ].join('\n'), BASE);
  assert.equal(segments.length, 1);
});

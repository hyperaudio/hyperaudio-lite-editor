// Unit tests for hls-source.js's pure helpers (#412): the media-playlist
// parser must keep handling byteranges/init segments correctly, and — since
// the manual segment path fetches raw bytes it cannot decrypt — an
// #EXT-X-KEY with a real METHOD must fail fast with a clear message instead
// of surfacing later as an opaque MP4 demux error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isHlsUrl, parseMediaPlaylist } = require('../../js/hls-source.js');

const BASE = 'https://example.com/vod/playlist.m3u8';

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

test('METHOD=NONE is not encryption and still parses', () => {
  const { segments } = parseMediaPlaylist([
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:4.0,',
    'seg1.ts',
  ].join('\n'), BASE);
  assert.equal(segments.length, 1);
});

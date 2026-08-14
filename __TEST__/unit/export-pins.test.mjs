// #571 — an exported interactive transcript is an archival artefact: it is
// published, linked and cited long after it leaves the editor. Unpinned CDN
// URLs made every such page track upstream HEAD forever, so a change in
// hyperaudio-lite could alter or break a transcript published years earlier.
//
// These assertions are the guard rail: no unpinned dependency may return, and
// the pin must match the player the editor itself vendors — otherwise the page
// you export behaves unlike the editor that made it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const template = readFileSync(new URL('../../hyperaudio-template.html', import.meta.url), 'utf8');
const player = readFileSync(new URL('../../js/hyperaudio-lite.js', import.meta.url), 'utf8');

test('every hyperaudio-lite dependency in the template is pinned', () => {
  const unpinned = [...template.matchAll(/cdn\.jsdelivr\.net\/gh\/hyperaudio\/hyperaudio-lite(?!@)[^"']*/g)]
    .map((m) => m[0]);
  assert.deepEqual(unpinned, [], 'unpinned CDN URLs in the exported page');
});

test('the pin matches the player version the editor vendors', () => {
  const pins = new Set([...template.matchAll(/hyperaudio-lite@([0-9][^/]*)\//g)].map((m) => m[1]));
  assert.equal(pins.size, 1, 'the template pins more than one version: ' + [...pins].join(', '));
  const vendored = player.match(/Version\s+([0-9.]+)/);
  assert.ok(vendored, 'no version marker in the vendored player');
  assert.equal([...pins][0], vendored[1],
    'the exported page would run a different player version than the editor');
});

test('no third-party CDN other than jsDelivr is loaded', () => {
  // Only what the page FETCHES counts: script src and stylesheet href. (SVG
  // xmlns values are namespace identifiers, not requests, and the footer's
  // hyperaudio.github.io is a link the reader may click, not a load.)
  const loaded = [...template.matchAll(/(?:<script[^>]*\ssrc|<link[^>]*\shref)="https?:\/\/([a-z0-9.-]+)\//gi)]
    .map((m) => m[1]);
  assert.deepEqual([...new Set(loaded)], ['cdn.jsdelivr.net']);
});

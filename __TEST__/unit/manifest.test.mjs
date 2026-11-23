// #825 — the app manifest names no host and no folder, so an installed copy
// opens the editor wherever it is served from: hyperaudio.github.io under
// /hyperaudio-lite-editor/, its own domain at the root, or a local server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
const paths = () => [manifest.start_url, manifest.scope, ...manifest.icons.map((icon) => icon.src)];

test('every path in the manifest is relative to the manifest', () => {
  paths().forEach((path) => {
    assert.ok(!path.startsWith('/'), `${path} starts at the root of the host`);
    assert.ok(!/^[a-z]+:/i.test(path), `${path} names a host`);
  });
});

test('wherever the editor is served from, the app starts on the editor, inside its scope', () => {
  [
    'https://hyperaudio.github.io/hyperaudio-lite-editor/manifest.json',
    'https://editor.example/manifest.json',
    'http://localhost:8888/some/folder/manifest.json',
  ].forEach((at) => {
    const folder = new URL('./', at).href;
    const start = new URL(manifest.start_url, at).href;
    const scope = new URL(manifest.scope, at).href;
    assert.equal(start, folder + 'index.html');
    assert.equal(scope, folder);
    assert.ok(start.startsWith(scope));
  });
});

test('on hyperaudio.github.io the app starts and is scoped where it was before', () => {
  const at = 'https://hyperaudio.github.io/hyperaudio-lite-editor/manifest.json';
  assert.equal(new URL(manifest.start_url, at).href, 'https://hyperaudio.github.io/hyperaudio-lite-editor/index.html');
  assert.equal(new URL(manifest.scope, at).href, 'https://hyperaudio.github.io/hyperaudio-lite-editor/');
});

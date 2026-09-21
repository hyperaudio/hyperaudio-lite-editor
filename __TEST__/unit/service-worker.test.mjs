// #665 — the service worker's precache list and cache version are hand-kept,
// and both rot silently: a script added to index.html and not to the list
// leaves the editor broken offline, and a version that does not move with the
// release leaves two releases' files in one cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const sw = fs.readFileSync(new URL('serviceworker.js', ROOT), 'utf8');
const html = fs.readFileSync(new URL('index.html', ROOT), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

const version = /const VERSION = '([^']+)'/.exec(sw)[1];
// the list's own comments hold apostrophes, so they go before the quotes are read
const precache = [.../const PRECACHE = \[([\s\S]*?)\];/.exec(sw)[1].replace(/\/\/.*$/gm, '')
  .matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('the cache version is the release\'s', () => {
  assert.equal(version, /name="version" content="([^"]+)"/.exec(html)[1]);
});

test('everything index.html loads from its own origin is precached', () => {
  const needed = [...html.matchAll(/<(?:script|link|img|source|track)\b[^>]*?\b(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:)?\/\/|^data:|^#|^mailto:/.test(u))
    .map((u) => u.split('?')[0].replace(/^\.\//, ''));
  assert.ok(needed.length > 40, 'expected to find the page\'s assets');
  const missing = [...new Set(needed)].filter((u) => !precache.includes(u));
  assert.deepEqual(missing, []);
});

test('the import map\'s libraries, the workers and the manifest\'s icons are precached', () => {
  const imports = Object.values(JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports)
    .map((u) => u.replace(/^\.\//, ''));
  const icons = JSON.parse(fs.readFileSync(new URL('manifest.json', ROOT), 'utf8')).icons.map((i) => i.src);
  const workers = ['js/whisper.worker.js', 'js/parakeet.worker.js'];
  const missing = [...imports, ...icons, ...workers, './', 'manifest.json'].filter((u) => !precache.includes(u));
  assert.deepEqual(missing, []);
});

test('every precached path exists, is relative, and carries no query string', () => {
  precache.forEach((path) => {
    assert.doesNotMatch(path, /^(https?:)?\/\/|^\/|\?/, path);
    if (path !== './') assert.ok(fs.existsSync(new URL(path, ROOT)), `${path} is listed and does not exist`);
  });
  assert.equal(new Set(precache).size, precache.length, 'duplicate entry');
});

// Unit tests for the Recents storage model (#434): entries keyed by stable ID
// with the display name in meta, legacy name-keyed entries migrated in place,
// name collisions suffixed instead of overwriting, and the list ordered by
// last-updated. All helpers run against a fake Storage so no DOM is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isDocKey,
  isLegacyKey,
  entryName,
  entryMediaKey,
  uniqueEntryName,
  listDocEntries,
  migrateLegacyEntries,
  renameTranscriptEntry,
  deleteTranscriptEntry,
  mediaNameFromRef,
} = require('../../js/hyperaudio-lite-editor-storage.js');

function fakeStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

const entry = (fields = {}) => JSON.stringify(Object.assign({
  hypertranscript: '<article><section><p><span data-m="0" data-d="1">x </span></p></section></article>',
  video: 'https://example.com/a.mp3',
  summary: 's',
  topics: [],
}, fields));

test('key classification: doc keys vs legacy keys vs unrelated keys', () => {
  assert.ok(isDocKey('hyperaudio:doc:abc123'));
  assert.ok(!isDocKey('alpha.hyperaudio'));
  assert.ok(isLegacyKey('alpha.hyperaudio'));
  assert.ok(!isLegacyKey('hyperaudio:doc:abc123'));
  assert.ok(!isLegacyKey('hyperaudioTranscribePrefs'));
  assert.ok(!isLegacyKey('.hyperaudio')); // name part must be non-empty (indexOf > 0)
});

test('migration: legacy entry moves to an ID key, name and mediaKey preserved', () => {
  const s = fakeStorage({ 'interview.hyperaudio': entry() });
  migrateLegacyEntries(s);
  assert.equal(s.getItem('interview.hyperaudio'), null);
  const rows = listDocEntries(s);
  assert.equal(rows.length, 1);
  assert.ok(isDocKey(rows[0].key));
  const migrated = JSON.parse(s.getItem(rows[0].key));
  assert.equal(migrated.meta.name, 'interview');
  assert.equal(migrated.meta.mediaKey, 'interview'); // media stays under its legacy key
  assert.ok(migrated.meta.created > 0); // stamped so the entry sorts by date from now on
  assert.equal(migrated.hypertranscript.includes('data-m'), true);
});

test('migration: an unparseable legacy entry stays on its legacy key and is still listed', () => {
  const s = fakeStorage({ 'broken.hyperaudio': '{not json', 'ok.hyperaudio': entry() });
  migrateLegacyEntries(s);
  assert.equal(s.getItem('broken.hyperaudio'), '{not json');
  const names = listDocEntries(s).map((r) => r.name).sort();
  assert.deepEqual(names, ['broken', 'ok']);
});

test('migration is idempotent', () => {
  const s = fakeStorage({ 'a.hyperaudio': entry() });
  migrateLegacyEntries(s);
  const keysAfterFirst = listDocEntries(s).map((r) => r.key);
  migrateLegacyEntries(s);
  assert.deepEqual(listDocEntries(s).map((r) => r.key), keysAfterFirst);
});

test('uniqueEntryName: suffixes instead of colliding, own key excluded', () => {
  const s = fakeStorage({
    'hyperaudio:doc:one': entry({ meta: { name: 'interview' } }),
    'hyperaudio:doc:two': entry({ meta: { name: 'interview (2)' } }),
  });
  assert.equal(uniqueEntryName('fresh', s, null), 'fresh');
  assert.equal(uniqueEntryName('interview', s, null), 'interview (3)');
  // an entry keeping its own name is not a collision with itself
  assert.equal(uniqueEntryName('interview', s, 'hyperaudio:doc:one'), 'interview');
});

test('listDocEntries: last-edited first, creation date stands in when never edited', () => {
  const s = fakeStorage({
    'hyperaudio:doc:a': entry({ meta: { name: 'older', updated: 1000 } }),
    'hyperaudio:doc:b': entry({ meta: { name: 'newest', updated: 3000 } }),
    'hyperaudio:doc:c': entry({ meta: { name: 'created-only', created: 2000 } }), // never edited → creation date
    'hyperaudio:doc:d': entry({ meta: { name: 'zeta' } }),  // no dates at all →
    'hyperaudio:doc:e': entry({ meta: { name: 'alpha' } }), // bottom, alphabetical
  });
  assert.deepEqual(listDocEntries(s).map((r) => r.name),
    ['newest', 'created-only', 'older', 'alpha', 'zeta']);
});

test('rename: one-field update, de-duplicated, key untouched; empty name rejected', () => {
  const s = fakeStorage({
    'hyperaudio:doc:one': entry({ meta: { name: 'a', mediaKey: 'm1', updated: 42 } }),
    'hyperaudio:doc:two': entry({ meta: { name: 'taken' } }),
  });
  assert.equal(renameTranscriptEntry('hyperaudio:doc:one', 'fresh', s), true);
  let e = JSON.parse(s.getItem('hyperaudio:doc:one'));
  assert.equal(e.meta.name, 'fresh');
  assert.equal(e.meta.mediaKey, 'm1');     // media key survives the rename
  assert.equal(e.meta.updated, 42);        // renaming must not reorder the list

  assert.equal(renameTranscriptEntry('hyperaudio:doc:one', 'taken', s), true);
  e = JSON.parse(s.getItem('hyperaudio:doc:one'));
  assert.equal(e.meta.name, 'taken (2)');

  assert.equal(renameTranscriptEntry('hyperaudio:doc:one', '   ', s), false);
  assert.equal(renameTranscriptEntry('hyperaudio:doc:missing', 'x', s), false);
});

test('delete: removes the entry, including an unparseable legacy one', () => {
  const s = fakeStorage({
    'hyperaudio:doc:one': entry({ meta: { name: 'a', mediaKey: 'm1' } }),
    'broken.hyperaudio': '{not json',
  });
  deleteTranscriptEntry('hyperaudio:doc:one', s);
  assert.equal(s.getItem('hyperaudio:doc:one'), null);
  deleteTranscriptEntry('broken.hyperaudio', s);
  assert.equal(s.getItem('broken.hyperaudio'), null);
  assert.equal(listDocEntries(s).length, 0);
});

test('mediaNameFromRef: URL basename (decoded), plain filename passthrough, Untitled fallback (#435)', () => {
  assert.equal(mediaNameFromRef('https://example.com/media/clip.mp4'), 'clip.mp4');
  assert.equal(mediaNameFromRef('https://example.com/media/My%20Interview.mp3?token=1#t=10'), 'My Interview.mp3');
  assert.equal(mediaNameFromRef('https://example.com/'), 'Untitled');        // no basename in the path
  assert.equal(mediaNameFromRef('interview.mp4'), 'interview.mp4');          // a local file's real name
  assert.equal(mediaNameFromRef(''), 'Untitled');
  assert.equal(mediaNameFromRef(null), 'Untitled');
});

test('entryName / entryMediaKey fall back sensibly for malformed entries', () => {
  assert.equal(entryName('alpha.hyperaudio', null), 'alpha');
  assert.equal(entryName('hyperaudio:doc:x', null), 'Untitled');
  assert.equal(entryMediaKey('alpha.hyperaudio', null), 'alpha');
  assert.equal(entryMediaKey('hyperaudio:doc:x', null), null);
  assert.equal(entryMediaKey('hyperaudio:doc:x', { meta: { mediaKey: 'm' } }), 'm');
});

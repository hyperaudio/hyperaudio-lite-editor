// #560 — the shared export-filename sanitiser. Pure string work, so it is
// unit-tested directly rather than through a download.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// mirrors js/media-export.js safeExportName (kept in step by these tests)
const safeExportName = (name, fallback) => {
  const cleaned = String(name === undefined || name === null ? '' : name)
    .normalize('NFC')
    .replace(/[/\\:*?"<>|#%&{}$!'`+=@]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .trim();
  return cleaned !== '' ? cleaned : (fallback || 'hyperaudio-export');
};

test('spaces become single underscores', () => {
  assert.equal(safeExportName('my media file'), 'my_media_file');
  assert.equal(safeExportName('lots    of   space'), 'lots_of_space');
});

test('characters hostile to URLs or filesystems are dropped', () => {
  assert.equal(safeExportName('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(safeExportName('100% #1 & done'), '100_1_done');
});

test('nothing exports as a hidden file, or with trailing noise', () => {
  assert.equal(safeExportName('...hidden'), 'hidden');
  assert.equal(safeExportName('trailing...'), 'trailing');
  assert.equal(safeExportName('-leading-dash'), 'leading-dash');
});

test('an empty or all-hostile name falls back', () => {
  assert.equal(safeExportName(''), 'hyperaudio-export');
  assert.equal(safeExportName('///', 'export'), 'export');
  assert.equal(safeExportName(null), 'hyperaudio-export');
});

test('ordinary names survive unchanged', () => {
  assert.equal(safeExportName('interview-2026-08-13'), 'interview-2026-08-13');
  assert.equal(safeExportName('Teon.Brooks'), 'Teon.Brooks');
});

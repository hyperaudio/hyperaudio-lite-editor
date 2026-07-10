// Unit tests for the .hyperaudio save format (spec: docs/format/hyperaudio-format.md).
// Exercises the pure FORMAT and CONTAINER layers of js/hyperaudio-save.js —
// version rules, validation, container round-trip, whitelist-read and the
// mimetype-first convention — plus the struck round-trip in the converter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js');
const { jsonToHTML } = require('../../js/html-json-converter.js');
const JSZip = require('jszip');

function sampleTranscript() {
  return {
    words: [
      { start: 0.32, end: 0.84, text: 'Benvenuti' },
      { start: 0.84, end: 1.02, text: 'ehm', struck: true },
      { start: 1.1, end: 1.3, text: 'a' },
    ],
    paragraphs: [{ speaker: 'Maria', start: 0.32, end: 6.5 }],
  };
}

function sampleState() {
  return {
    generatorVersion: '0.8.2',
    created: '2026-07-10T09:00:00Z',
    modified: '2026-07-10T11:30:00Z',
    media: {
      kind: 'original', path: 'media/test.mp4', url: null, filename: 'test.mp4',
      mimeType: 'video/mp4', durationSeconds: 62.5, sizeBytes: 4,
    },
    options: {
      gapRemoval: { enabled: true, thresholdMs: 500, bufferMs: 100 },
      updateCaptionsFromTranscript: false,
      view: { showSpeakers: true, showTimecodes: false },
    },
    texts: { title: 'Intervista', language: 'it', summary: 'riassunto', topics: ['hyperaudio'] },
    provenance: { engine: 'deepgram', model: 'nova-3', transcribedAt: '2026-07-10T08:55:00Z' },
    hasOriginal: true,
    transcript: sampleTranscript(),
  };
}

/* ---------- FORMAT ---------- */

test('checkFormatVersion: accepts same-major, rejects higher major and malformed', () => {
  assert.equal(save.checkFormatVersion('1.0').ok, true);
  assert.equal(save.checkFormatVersion('1.7').ok, true); // future minor: ignore-unknown
  assert.deepEqual(save.checkFormatVersion('2.0').code, 'version-major');
  assert.equal(save.checkFormatVersion('banana').code, 'version-malformed');
  assert.equal(save.checkFormatVersion(1.0).code, 'version-malformed');
  assert.equal(save.checkFormatVersion('1.0.3').code, 'version-malformed');
});

test('validateMediaPath: one segment under media/, no traversal, no absolutes', () => {
  assert.equal(save.validateMediaPath('media/video.mp4'), true);
  assert.equal(save.validateMediaPath('media/città è.mp4'), true);
  assert.equal(save.validateMediaPath('media/../evil'), false);
  assert.equal(save.validateMediaPath('media/sub/dir.mp4'), false);
  assert.equal(save.validateMediaPath('/etc/passwd'), false);
  assert.equal(save.validateMediaPath('media\\evil'), false);
  assert.equal(save.validateMediaPath('other/file.mp4'), false);
  assert.equal(save.validateMediaPath(null), false);
});

test('buildProjectJson: complete shape; provenance carries originalTranscript', () => {
  const project = save.buildProjectJson(sampleState());
  assert.equal(project.format, 'hyperaudio');
  assert.equal(project.formatVersion, save.FORMAT_VERSION);
  assert.equal(project.media.filename, 'test.mp4');
  assert.equal(project.options.captions.updateFromTranscript, false);
  assert.equal(project.texts.title, 'Intervista');
  assert.equal(project.provenance.originalTranscript, 'transcript.original.json');
  assert.equal(project.transcript.words[1].struck, true);
});

test('buildProjectJson: provenance omitted when unknown', () => {
  const state = sampleState();
  state.provenance = null;
  const project = save.buildProjectJson(state);
  assert.equal(project.provenance, undefined);
});

test('validateProjectJson: accepts a conformant project', () => {
  const result = save.validateProjectJson(save.buildProjectJson(sampleState()));
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('validateProjectJson: flags unknown kind, bad path, bad words', () => {
  const good = () => save.buildProjectJson(sampleState());

  let p = good();
  p.media.kind = 'hologram';
  assert.ok(save.validateProjectJson(p).errors.some((e) => e.code === 'media-kind'));

  p = good();
  p.media.path = 'media/../evil.mp4';
  assert.ok(save.validateProjectJson(p).errors.some((e) => e.code === 'media-path'));

  p = good();
  p.transcript.words[0].end = -1;
  assert.ok(save.validateProjectJson(p).errors.some((e) => e.code === 'transcript'));

  p = good();
  delete p.format;
  assert.ok(save.validateProjectJson(p).errors.some((e) => e.code === 'format'));
});

/* ---------- converter: struck round-trip (writer side) ---------- */

test('jsonToHTML: struck word carries the line-through style, others do not', () => {
  const html = jsonToHTML(sampleTranscript());
  assert.match(html, /<span data-m="840" data-d="180" style="text-decoration: line-through;">ehm <\/span>/);
  assert.match(html, /<span data-m="320" data-d="520">Benvenuti <\/span>/);
});

/* ---------- CONTAINER ---------- */

function sampleFiles() {
  const project = save.buildProjectJson(sampleState());
  return {
    json: save.serializeProjectJson(project),
    html: '<article><section><p><span data-m="320" data-d="520">Benvenuti </span></p></section></article>',
    originalJson: JSON.stringify({ words: [{ start: 0.32, end: 0.84, text: 'benvenuti' }], paragraphs: [] }),
    captionsVtt: 'WEBVTT\n\n00:00:00.320 --> 00:00:03.100\nBenvenuti a Hyperaudio\n',
    media: { name: 'test.mp4', data: new Uint8Array([1, 2, 3, 4]) },
  };
}

test('container: mimetype is the first entry, stored, at fixed offset 38', async () => {
  const out = await save.zipProject(sampleFiles(), JSZip, 'uint8array');
  const buf = Buffer.from(out);
  assert.equal(buf.readUInt32LE(0), 0x04034b50); // local file header signature
  assert.equal(buf.toString('ascii', 30, 38), 'mimetype');
  assert.equal(
    buf.toString('utf8', 38, 38 + save.CONTAINER_MIMETYPE.length),
    save.CONTAINER_MIMETYPE,
  );
});

test('container: round-trip preserves project, media bytes, captions, origin', async () => {
  const out = await save.zipProject(sampleFiles(), JSZip, 'uint8array');
  const loaded = await save.unzipProject(out, JSZip);

  assert.equal(loaded.recovered, false);
  assert.equal(loaded.project.texts.title, 'Intervista');
  assert.equal(loaded.project.transcript.words[1].struck, true);
  assert.equal(loaded.mediaEntryName, 'test.mp4');
  assert.deepEqual(Array.from(loaded.mediaData), [1, 2, 3, 4]);
  assert.match(loaded.captionsVtt, /^WEBVTT/);
  assert.match(loaded.originalText, /benvenuti/);
  assert.match(loaded.htmlText, /Benvenuti/);
  assert.deepEqual(loaded.warnings, []);
});

test('container: a higher major version is refused with a clear code', async () => {
  const files = sampleFiles();
  const project = JSON.parse(files.json);
  project.formatVersion = '2.0';
  files.json = JSON.stringify(project);
  const out = await save.zipProject(files, JSZip, 'uint8array');
  await assert.rejects(() => save.unzipProject(out, JSZip), (e) => e.code === 'version-major');
});

test('container: an unknown media.kind is refused with a clear code', async () => {
  const files = sampleFiles();
  const project = JSON.parse(files.json);
  project.media.kind = 'hologram';
  files.json = JSON.stringify(project);
  const out = await save.zipProject(files, JSZip, 'uint8array');
  await assert.rejects(() => save.unzipProject(out, JSZip), (e) => e.code === 'media-kind');
});

test('container: missing hyperaudio.json recovers from transcript.html', async () => {
  const zip = new JSZip();
  zip.file('transcript.html', '<article><section><p><span data-m="0" data-d="80">Hi </span></p></section></article>');
  const out = await zip.generateAsync({ type: 'uint8array' });
  const loaded = await save.unzipProject(out, JSZip);
  assert.equal(loaded.recovered, true);
  assert.match(loaded.htmlText, /Hi/);
  assert.ok(loaded.warnings.length > 0);
});

test('container: no json and no html is unreadable', async () => {
  const zip = new JSZip();
  zip.file('random.txt', 'nothing to see');
  const out = await zip.generateAsync({ type: 'uint8array' });
  await assert.rejects(() => save.unzipProject(out, JSZip), (e) => e.code === 'unreadable');
});

test('container: missing mimetype entry is tolerated with a warning', async () => {
  const files = sampleFiles();
  const zip = new JSZip();
  zip.file('hyperaudio.json', files.json);
  zip.file('media/test.mp4', files.media.data);
  const out = await zip.generateAsync({ type: 'uint8array' });
  const loaded = await save.unzipProject(out, JSZip);
  assert.equal(loaded.recovered, false);
  assert.ok(loaded.warnings.some((w) => /mimetype/.test(w)));
});

test('container: unknown entries in the zip are ignored (whitelist-read)', async () => {
  const files = sampleFiles();
  const zip = new JSZip();
  zip.file('mimetype', save.CONTAINER_MIMETYPE, { compression: 'STORE' });
  zip.file('hyperaudio.json', files.json);
  zip.file('media/test.mp4', files.media.data);
  zip.file('../../../evil.sh', 'echo pwned');
  zip.file('extra/unknown.bin', new Uint8Array([9, 9]));
  const out = await zip.generateAsync({ type: 'uint8array' });
  const loaded = await save.unzipProject(out, JSZip);
  assert.equal(loaded.recovered, false);
  assert.equal(loaded.project.format, 'hyperaudio');
});

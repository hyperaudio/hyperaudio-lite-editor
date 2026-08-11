// Unit tests for the .hyperaudio save format (spec: issue #403).
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

test('buildProjectJson: provenance seconds/device persist when captured (§ 3.5, 1.3 / #457)', () => {
  const state = sampleState();
  state.provenance = { ...state.provenance, seconds: 42.7, device: 'GPU (WebGPU)' };
  const project = save.buildProjectJson(state);
  assert.equal(project.provenance.seconds, 42.7);
  assert.equal(project.provenance.device, 'GPU (WebGPU)');
  // still valid against the project validator
  assert.deepEqual(save.validateProjectJson(project), { ok: true, errors: [] });
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

test('validateProjectJson: link kind needs an http(s) url, and nothing else', () => {
  const p = save.buildProjectJson(sampleState());
  p.media = { kind: 'link', path: null, url: 'https://example.org/media.mp3', filename: '', mimeType: '', durationSeconds: 62.5, sizeBytes: 0 };
  assert.deepEqual(save.validateProjectJson(p), { ok: true, errors: [] });

  p.media.url = 'file:///etc/passwd';
  assert.ok(save.validateProjectJson(p).errors.some((e) => e.code === 'media'));

  p.media.url = null;
  assert.ok(save.validateProjectJson(p).errors.some((e) => e.code === 'media'));
});

test('validateProjectJson: a declared embedder scheme is accepted for link urls', () => {
  const p = save.buildProjectJson(sampleState());
  p.media = { kind: 'link', path: null, url: 'app-media://token/file.mp4', filename: 'file.mp4', mimeType: '', durationSeconds: 62.5, sizeBytes: 0 };
  // Undeclared: rejected exactly as before.
  assert.ok(save.validateProjectJson(p).errors.some((e) => e.code === 'media'));
  globalThis.hyperaudioLinkSchemes = ['app-media:'];
  try {
    assert.deepEqual(save.validateProjectJson(p), { ok: true, errors: [] });
    // Declaring one scheme does not open the door to others.
    p.media.url = 'other-scheme://x/y';
    assert.ok(save.validateProjectJson(p).errors.some((e) => e.code === 'media'));
  } finally {
    delete globalThis.hyperaudioLinkSchemes;
  }
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

test('container: a link project round-trips with no media entry (v1.1)', async () => {
  const files = sampleFiles();
  const project = JSON.parse(files.json);
  project.media = { kind: 'link', path: null, url: 'https://example.org/media.mp3', filename: '', mimeType: '', durationSeconds: 62.5, sizeBytes: 0 };
  files.json = JSON.stringify(project);
  files.media = null;
  const out = await save.zipProject(files, JSZip, 'uint8array');
  const loaded = await save.unzipProject(out, JSZip);

  assert.equal(loaded.recovered, false);
  assert.equal(loaded.project.media.kind, 'link');
  assert.equal(loaded.project.media.url, 'https://example.org/media.mp3');
  assert.equal(loaded.mediaData, null);
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

/* ---- format v1.2 parity (#447; spec § 7.1, 7.2.2, 8.1, 10.2, 10.3) ---- */

test('media.path: ".." substring is legal, exact traversal segments are not (§ 10.2)', () => {
  assert.equal(save.validateMediaPath('media/mix..final.mp3'), true);   // the regression class
  assert.equal(save.validateMediaPath('media/tone.wav'), true);
  assert.equal(save.validateMediaPath('media/..'), false);
  assert.equal(save.validateMediaPath('media/.'), false);
  assert.equal(save.validateMediaPath('media/'), false);
  assert.equal(save.validateMediaPath('media/a/b.mp3'), false);
  assert.equal(save.validateMediaPath('media/a\\b.mp3'), false);
  assert.equal(save.validateMediaPath('elsewhere/a.mp3'), false);
});

test('sanitizeMediaFilename mirrors the reader rule (§ 10.2)', () => {
  assert.equal(save.sanitizeMediaFilename('mix..final.mp3'), 'mix..final.mp3'); // preserved
  assert.equal(save.sanitizeMediaFilename('a/b\\c.mp3'), 'a_b_c.mp3');
  assert.equal(save.sanitizeMediaFilename('..'), 'media');
  assert.equal(save.sanitizeMediaFilename('  '), 'media');
  assert.equal(save.sanitizeMediaFilename(null), 'media');
});

test('rewrites preserve unknown envelope fields, top-level and nested (§ 8.1)', () => {
  const envelope = {
    format: 'hyperaudio', formatVersion: '1.4',
    futureBlock: { anything: true },
    created: '2020-01-01T00:00:00Z',
    options: { gapRemoval: { enabled: false }, futureOption: 'keep-me', captions: { updateFromTranscript: true, futureCaptionKey: 7 } },
    texts: { title: 'old', futureText: 'keep-me-too' },
  };
  const project = save.buildProjectJson({
    envelope,
    generatorVersion: 'x', created: envelope.created, modified: 'now',
    media: { kind: 'none', path: null, url: null, filename: '', mimeType: '', durationSeconds: 0, sizeBytes: 0 },
    options: { gapRemoval: { enabled: true, thresholdMs: 500, bufferMs: 100 }, updateCaptionsFromTranscript: false, view: { showSpeakers: true, showTimecodes: false } },
    texts: { title: 'new', language: '', summary: '', topics: [] },
    transcript: { words: [] },
  });
  assert.equal(project.futureBlock.anything, true);            // unknown top-level survives
  assert.equal(project.options.futureOption, 'keep-me');       // unknown inside known object survives
  assert.equal(project.options.captions.futureCaptionKey, 7);  // ...even nested two deep
  assert.equal(project.texts.futureText, 'keep-me-too');
  assert.equal(project.texts.title, 'new');                    // owned fields overwritten
  assert.equal(project.options.captions.updateFromTranscript, false);
  assert.equal(project.formatVersion, save.FORMAT_VERSION);    // writers write their own version
  assert.equal(save.FORMAT_VERSION, '1.3');
  assert.equal(envelope.texts.title, 'old');                   // the input envelope is not mutated
});

test('media.kind "none": validates and round-trips a media-less container (§ 7.2.2)', async () => {
  const state = {
    generatorVersion: 'x', created: 'c', modified: 'm',
    media: { kind: 'none', path: null, url: null, filename: '', mimeType: '', durationSeconds: 0, sizeBytes: 0 },
    options: { gapRemoval: { enabled: false, thresholdMs: 500, bufferMs: 100 }, updateCaptionsFromTranscript: true, view: {} },
    texts: { title: 't', language: '', summary: '', topics: [] },
    transcript: { words: [{ start: 0, end: 1, text: 'a' }] },
  };
  const project = save.buildProjectJson(state);
  assert.equal(save.validateProjectJson(project).ok, true);
  const zipped = await save.zipProject({ json: save.serializeProjectJson(project), html: '<article></article>' }, JSZip, 'nodebuffer');
  const loaded = await save.unzipProject(new Uint8Array(zipped), JSZip);
  assert.equal(loaded.recovered, false);
  assert.equal(loaded.project.media.kind, 'none');
  assert.equal(loaded.mediaData, null);
  assert.deepEqual(loaded.warnings, []); // "none" is not "missing" — no warning
});

test('invalid UTF-8 in a text entry is refused, not silently replaced (§ 10.3)', async () => {
  const zip = new JSZip();
  zip.file('mimetype', save.CONTAINER_MIMETYPE, { compression: 'STORE' });
  zip.file('hyperaudio.json', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])); // {<invalid>}
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(save.unzipProject(new Uint8Array(buf), JSZip), (e) => e.code === 'entry-invalid-utf8');
});

test('a compressed media entry is refused (§ 7.1) — pins JSZip metadata access too', async () => {
  const state = {
    generatorVersion: 'x', created: 'c', modified: 'm',
    media: { kind: 'original', path: 'media/tone.wav', url: null, filename: 'tone.wav', mimeType: 'audio/wav', durationSeconds: 1, sizeBytes: 4 },
    options: { gapRemoval: { enabled: false, thresholdMs: 500, bufferMs: 100 }, updateCaptionsFromTranscript: true, view: {} },
    texts: { title: 't', language: '', summary: '', topics: [] },
    transcript: { words: [{ start: 0, end: 1, text: 'a' }] },
  };
  const zip = new JSZip();
  zip.file('mimetype', save.CONTAINER_MIMETYPE, { compression: 'STORE' });
  zip.file('hyperaudio.json', save.serializeProjectJson(save.buildProjectJson(state)));
  zip.file('media/tone.wav', new Uint8Array(4096), { compression: 'DEFLATE' }); // forbidden
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await assert.rejects(save.unzipProject(new Uint8Array(buf), JSZip), (e) => e.code === 'media-compressed');
});

test('the writer sanitizes hostile media entry names with the shared rule (§ 10.2)', async () => {
  const zipped = await save.zipProject({
    json: '{}', html: '<article></article>',
    media: { name: '../evil.wav', data: new Uint8Array(8) },
  }, JSZip, 'nodebuffer');
  const zip = await JSZip.loadAsync(zipped);
  assert.ok(zip.file('media/.._evil.wav') !== null);  // separator neutralized, ".." substring kept
  assert.equal(zip.file('media/../evil.wav'), null);
});

/* ---- Library index rules (#456) — pure layer of the project library ---- */

test('library entries sort by last edit, created date the fallback (#456)', () => {
  const sorted = save.sortLibraryEntries([
    { id: 'a', modifiedAt: 100 },
    { id: 'b', modifiedAt: 300 },
    { id: 'c', createdAt: 200 },       // never written: created decides
    { id: 'd', modifiedAt: 0, createdAt: 400 }, // modifiedAt 0 falls back too
  ]);
  assert.deepEqual(sorted.map((e) => e.id), ['d', 'b', 'c', 'a']);
});

test('sortLibraryEntries does not mutate its input', () => {
  const entries = [{ id: 'a', modifiedAt: 1 }, { id: 'b', modifiedAt: 2 }];
  save.sortLibraryEntries(entries);
  assert.deepEqual(entries.map((e) => e.id), ['a', 'b']);
});

test('per-project dirty: a draft newer than the last manual Save (#456)', () => {
  assert.equal(save.isEntryDirty({ lastDraftAt: 2, lastSavedAt: 1 }), true);
  assert.equal(save.isEntryDirty({ lastDraftAt: 1, lastSavedAt: 1 }), false);
  assert.equal(save.isEntryDirty({ lastDraftAt: 0, lastSavedAt: 2 }), false); // freshly saved
  assert.equal(save.isEntryDirty({ lastDraftAt: 5 }), true); // never saved (fresh transcription)
  assert.equal(save.isEntryDirty({}), false);                // nothing written yet
});

test('project ids are unique and safe as OPFS directory names (#456)', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(save.newProjectId());
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9-]+$/);
});

test('gather-side class sanitizer keeps the speaker class, strips pollution (#456)', () => {
  const html = '<p><span data-m="320" data-d="0" class="speaker">[Maria] </span>'
    + '<span data-m="320" data-d="520" class="active read">Benvenuti </span>'
    + '<span data-m="1100" data-d="400" class="read speaker-adjacent">a </span></p>';
  const out = save.sanitizeTranscriptClasses(html);
  assert.ok(out.includes('class="speaker"'));           // semantic class survives…
  assert.ok(!out.includes('active'));                   // …playback classes go
  assert.ok(!out.includes('speaker-adjacent'));         // substring must not fake a match
  // a polluted speaker span ("speaker read") collapses to exactly class="speaker"
  const mixed = save.sanitizeTranscriptClasses('<span data-m="0" class="speaker read">[A] </span>');
  assert.equal(mixed, '<span data-m="0" class="speaker">[A] </span>');
});

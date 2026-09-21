// #668 — transcript provenance (TPME v1.0) entries, built by a pure function
// from what a project records. The file format is the AAPB profile's: a JSON
// array, one entry per step, chained by parent_transcript_id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const tpme = createRequire(import.meta.url)('../../js/tpme.js');
const JS = new URL('../../js/', import.meta.url);

// v1.0's nine RECOMMENDED elements
const RECOMMENDED = ['media_id', 'modification_date', 'provider', 'transcript_language', 'type',
  'human_review_level', 'application_name', 'application_version', 'application_parameters'];

const project = (over = {}) => Object.assign({
  mediaId: 'cpb-aacip-123', title: 'An interview', language: 'en-US', mediaFilename: 'interview.mp4',
  provider: 'Example Archive', editor: 'editor@example.org', generatorVersion: '1.3.22',
  provenance: {
    engine: 'whisper (local, in your browser)', model: 'Whisper Small (English)', transcribedAt: '2026-09-01T10:00:00.000Z',
    modelId: 'onnx-community/whisper-small.en_timestamped', parameters: { model: 'onnx-community/whisper-small.en_timestamped', language: 'en' },
    runtime: 'transformers.js', engineVersion: '4.2.0', device: 'GPU (WebGPU)', seconds: 42.7, mediaFile: 'interview.mp4',
  },
  imported: [], reviewLevel: '', edited: true, speakerDiarization: true, maxLineChars: 32, conventions: ['struck_words_removed'],
}, over);
const OUTPUTS = [
  { name: 'interview.vtt', format: 'text/vtt', type: 'captions', checksum: 'sha256:aa' },
  { name: 'interview-transcript.html', format: 'text/html', type: 'transcript', checksum: 'sha256:bb' },
];
const NOW = '2026-09-21T14:02:30.123Z';

test('a transcript made here and then corrected: the ASR step, then a step per file', () => {
  const entries = tpme.buildEntries(project(), OUTPUTS, NOW);
  assert.equal(entries.length, 3);
  const [asr, vtt, html] = entries;

  assert.equal(asr.application_type, 'ASR');
  assert.equal(asr.human_review_level, 'machine-generated');
  assert.equal(asr.inference_model, 'onnx-community/whisper-small.en_timestamped');   // the canonical name, not the picker's label
  assert.equal(asr.application_name, 'transformers.js');
  assert.equal(asr.application_version, '4.2.0');
  assert.equal(asr.modification_date, '2026-09-01T10:00:00.000Z');
  assert.equal(asr.originating_media_file, 'interview.mp4');
  assert.equal(asr.parent_transcript_id, undefined);
  RECOMMENDED.forEach((key) => assert.ok(key in asr, `ASR entry lacks ${key}`));

  [vtt, html].forEach((entry, i) => {
    assert.equal(entry.transcript_id, OUTPUTS[i].name);
    assert.equal(entry.parent_transcript_id, asr.transcript_id);            // the chain
    assert.equal(entry.transcript_checksum, OUTPUTS[i].checksum);
    assert.equal(entry.modification_date, NOW);
    assert.equal(entry.application_name, 'Hyperaudio Lite Editor');
    assert.equal(entry.application_version, '1.3.22');
    assert.equal(entry.application_type, 'transcript editor');
    assert.equal(entry.human_review_level, 'partially-corrected');
    assert.equal(entry.human_agent, 'editor@example.org');
    assert.deepEqual(entry.transcript_language, ['en-US']);
    assert.deepEqual(entry.conventions, ['struck_words_removed']);
  });
  assert.equal(vtt.type, 'captions');
  assert.equal(vtt.file_format, 'text/vtt');
  assert.equal(vtt.features.max_line_chars, 32);
  assert.equal(html.features.max_line_chars, undefined);                     // a caption's property, not a transcript's
  // v1.0's name for the element, not the profile's drift
  entries.forEach((e) => assert.ok(!('application_params' in e)));
});

test('untouched machine output is a conversion, not a review, and names no editor', () => {
  const [, vtt] = tpme.buildEntries(project({ edited: false }), OUTPUTS, NOW);
  assert.equal(vtt.human_review_level, 'machine-generated');
  assert.equal(vtt.application_type, 'format-conversion');
  assert.equal(vtt.human_agent, undefined);
});

test('the user\'s word for the review level is written as given', () => {
  assert.equal(tpme.buildEntries(project({ reviewLevel: 'staff-corrected' }), OUTPUTS, NOW)[1].human_review_level, 'staff-corrected');
  assert.equal(tpme.buildEntries(project({ reviewLevel: 'Reviewed to house style v3' }), OUTPUTS, NOW)[1].human_review_level, 'Reviewed to house style v3');
  // and a transcript nobody can vouch for says so
  assert.equal(tpme.reviewLevel({ chosen: '', edited: null, hasEngine: false }), 'third-party-unknown');
  assert.equal(tpme.reviewLevel({ chosen: '', edited: null, hasEngine: true }), 'machine-generated');
});

test('a chain that arrived with the transcript is kept exactly, and ours is appended to it', () => {
  const imported = [
    { media_id: 'cpb-aacip-123', transcript_id: 'cpb-aacip-123-transcript.json', parent_transcript_id: 'cpb-aacip-123-transcript.mmif',
      modification_date: '2025-12-19T14:57:52.526575', application_params: { max_segment_chars: 110 }, some_local_element: [1, 2] },
    { media_id: 'cpb-aacip-123', transcript_id: 'cpb-aacip-123-transcript.mmif', modification_date: '2025-12-19T04:12:27.464650' },
  ];
  const entries = tpme.buildEntries(project({ provenance: null, imported, edited: null, reviewLevel: 'staff-corrected' }), OUTPUTS, NOW);
  assert.deepEqual(entries.slice(0, 2), imported);                           // untouched: their spelling, their extra elements
  assert.equal(entries.length, 4);                                           // no ASR step of ours
  // derived from the NEWEST of theirs by date, whatever its position
  assert.equal(entries[2].parent_transcript_id, 'cpb-aacip-123-transcript.json');
});

test('a project from before the engines recorded what they ran still describes itself', () => {
  const old = project({ provenance: { engine: 'deepgram (cloud)', model: 'Nova-3 (recommended)', transcribedAt: '2026-07-10T08:55:00Z' } });
  const [asr] = tpme.buildEntries(old, OUTPUTS, NOW);
  assert.equal(asr.application_name, 'Deepgram');
  assert.equal(asr.application_version, 'UNKNOWN');                          // the profile's word for it
  assert.equal(asr.inference_model, 'Nova-3 (recommended)');
  assert.ok(!('application_parameters' in asr));
});

test('the file is named by the AAPB pattern, in UTC', () => {
  assert.equal(tpme.fileName('cpb-aacip-508-125q815826', '2025-12-19T14:57:52.526Z'), 'cpb-aacip-508-125q815826-tpme-20251219-145752.json');
  assert.equal(tpme.fileName('My interview: part 1', NOW), 'My_interview_part_1-tpme-20260921-140230.json');
  assert.equal(tpme.fileName('', NOW), 'transcript-tpme-20260921-140230.json');
});

test('merging drops an entry that is the same step, however its keys are ordered', () => {
  const a = [{ media_id: 'x', transcript_id: 't1', features: { time_aligned: true, max_line_chars: 40 } }];
  const b = [{ transcript_id: 't1', features: { max_line_chars: 40, time_aligned: true }, media_id: 'x' }, { media_id: 'x', transcript_id: 't2' }];
  assert.equal(tpme.mergeEntries(a, b).length, 2);
  assert.deepEqual(tpme.mediaIds(tpme.mergeEntries(a, b)), ['x']);
});

test('a TPME file is an array of entries, or one entry; anything else is refused', () => {
  assert.equal(tpme.parseFile('[{"media_id":"x"},{"media_id":"x","application_name":"kaldi"}]').length, 2);
  assert.equal(tpme.parseFile('{"media_id":"x","human_review_level":"None"}').length, 1);      // v1.0, example 1
  assert.throws(() => tpme.parseFile('not json'), /not a JSON file/);
  assert.throws(() => tpme.parseFile('[1, 2]'), /list of entries/);
  assert.throws(() => tpme.parseFile('[{"words":[]}]'), /None of the TPME elements/);
});

test('edited means the words changed or one was struck — not that a timing moved', () => {
  const original = [{ text: 'Hello', start: 0 }, { text: 'world.', start: 0.5 }];
  assert.equal(tpme.wasEdited(original, [{ text: 'Hello ' }, { text: 'world. ' }]), false);
  assert.equal(tpme.wasEdited(original, [{ text: 'Hullo ' }, { text: 'world. ' }]), true);
  assert.equal(tpme.wasEdited(original, [{ text: 'Hello ' }, { text: 'world. ', struck: true }]), true);
  assert.equal(tpme.wasEdited(null, [{ text: 'Hello' }]), null);
});

test('every engine reports what it really ran, and the local ones name their worker\'s runtime', () => {
  const read = (name) => fs.readFileSync(new URL(name, JS), 'utf8');
  ['hyperaudio-lite-editor-deepgram.js', 'hyperaudio-lite-editor-assemblyai.js', 'hyperaudio-lite-editor-parakeet.js',
    'hyperaudio-lite-editor-whisper.js', 'hyperaudio-lite-editor-parakeet-local.js'].forEach((file) => {
    const src = read(file);
    assert.match(src, /modelId:/, `${file} reports no modelId`);
    assert.match(src, /parameters:/, `${file} reports no parameters`);
    assert.doesNotMatch(src, /parameters:[^;]*(apiKey|token|Authorization)/i, `${file} puts a credential in its parameters`);
  });
  const whisperRuntime = /transformers@([0-9.]+)/.exec(read('whisper.worker.js'))[1];
  assert.match(read('hyperaudio-lite-editor-whisper.js'), new RegExp(`engineVersion: '${whisperRuntime.replace(/\./g, '\\.')}'`));
  const ortRuntime = /onnxruntime-web@([0-9.]+)/.exec(read('parakeet.worker.js'))[1];
  assert.match(read('hyperaudio-lite-editor-parakeet-local.js'), new RegExp(`engineVersion: "${ortRuntime.replace(/\./g, '\\.')}"`));
  assert.match(read('parakeet.worker.js'), /istupakov\/parakeet-tdt-0\.6b-v3-onnx/);
});

test('a checksum that is left out says why, in the entry itself', async () => {
  const { createHash } = await import('node:crypto');
  const blob = new Blob(['WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n']);
  const small = await tpme.checksumOf(blob);
  assert.equal(small.checksum, 'sha256:' + createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex'));
  assert.equal(small.note, '');

  // over the limit (here a tiny one, so the test needs no 64 MB file)
  const big = await tpme.checksumOf(new Blob([new Uint8Array(3 * 1024 * 1024)]), 2 * 1024 * 1024);
  assert.equal(big.checksum, '');
  assert.match(big.note, /^transcript_checksum omitted: the file is 3 MB, more than the 2 MB/);
  assert.equal(tpme.CHECKSUM_LIMIT_BYTES, 64 * 1024 * 1024);

  // and the note reaches the entry, where someone reading the record will see it
  const [, entry] = tpme.buildEntries(project(), [{ name: 'interview.hyperaudio', format: 'application/vnd.hyperaudio+zip', type: 'transcript', checksum: big.checksum, note: big.note }], NOW);
  assert.equal(entry.transcript_checksum, undefined);
  assert.equal(entry.processing_note, big.note);
  // an entry WITH a checksum carries no such note
  assert.equal(tpme.buildEntries(project(), OUTPUTS, NOW)[1].processing_note, undefined);
});

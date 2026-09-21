// #668 — transcript provenance sidecars (TPME v1.0, in the AAPB profile's
// file format): how a transcript came to be, written beside the files the
// editor exports. Off by default, and invisible while off — except that what
// the engines really ran is recorded in every project regardless, because
// that cannot be recovered later.
import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { ladderWav, withoutIntroProject } from './helpers.mjs';

const wordsHtml = (words) => '<article><section><p><span class="speaker" data-m="0" data-d="0">[Ann] </span>' + words.map((w, i) =>
  `<span data-m="${i * 1000}" data-d="1000">${w} </span>`).join('') + '</p></section></article>';

const ENGINE = {
  service: 'Whisper (local, in your browser)', model: 'Whisper Small (English)', language: 'English', languageCode: 'en',
  modelId: 'onnx-community/whisper-small.en_timestamped', runtime: 'transformers.js', engineVersion: '4.2.0',
  parameters: { model: 'onnx-community/whisper-small.en_timestamped', language: 'en', word_timestamps: true },
  device: 'GPU (WebGPU)', seconds: 12.3,
};

// A project born the way an engine makes one: the file through a picker, the
// busy signal, the engine's report, then the transcript.
const makeProject = async (page, name, words, info = ENGINE) => {
  await page.route(`**/__${name}`, (route) => route.fulfill({ body: ladderWav(words.length), contentType: 'audio/wav' }));
  await page.evaluate(async ([name, html, info]) => {
    const blob = await (await fetch('/__' + name)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], name, { type: 'audio/wav' }));
    const input = document.querySelector('#deepgram-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('#hypertranscript').innerHTML = '<div>Transcribing….</div>';
    window.setTranscriptBusy(true);
    await new Promise((r) => setTimeout(r, 800));
    document.querySelector('#hypertranscript').innerHTML = html;
    if (info !== null) window.setTranscriptionInfo(info);
    window.setTranscriptBusy(false);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  }, [name, wordsHtml(words), info]);
  await expect.poll(() => page.evaluate(async () => ((await window.HyperaudioSave.library.list())[0] || {}).name)).toBe(name);
  const id = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await expect.poll(() => page.evaluate(async (id) => (await window.HyperaudioSave.mediaFileFor(id)) !== null, id)).toBe(true);
  await expect.poll(() => page.evaluate(async (id) => (await window.HyperaudioSave.originalTranscriptFor(id)) !== null, id)).toBe(true);
  await page.waitForFunction(() => document.getElementById('hyperplayer').readyState >= 1);
  return id;
};

const turnOn = (page, fields = {}) => page.evaluate((fields) => {
  const t = document.getElementById('setting-tpme-enabled');
  t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true }));
  [['setting-tpme-provider', fields.provider], ['setting-tpme-editor', fields.editor]].forEach(([id, value]) => {
    if (value === undefined) return;
    const f = document.getElementById(id); f.value = value; f.dispatchEvent(new Event('change', { bubbles: true }));
  });
}, fields);

const setUpExport = async (page, name, extras) => {
  await page.evaluate(() => { const m = document.getElementById('export-modal'); m.checked = true; m.dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
  await page.selectOption('#export-format', 'wav');
  await page.evaluate(([name, extras]) => {
    for (const id of ['export-retime', 'export-vtt', 'export-srt', 'export-project', 'export-burn', 'export-zip', 'export-tpme']) {
      const c = document.getElementById(id);
      if (c) { c.checked = extras.includes(id); c.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    document.getElementById('export-name').value = name;
  }, [name, extras]);
};

const runExport = async (page, expected) => {
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.click('#export-start');
  await page.waitForFunction(() => /^(Done|Export failed)/.test(document.getElementById('export-status').textContent), null, { timeout: 90000 });
  await expect.poll(() => downloads.length).toBe(expected);
  const fs = await import('node:fs/promises');
  const files = {};
  for (const d of downloads) files[d.suggestedFilename()] = await fs.readFile(await d.path());
  return files;
};

const sha = (buffer) => 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
const visible = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return el !== null && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}, selector);
const savedProvenance = (page) => page.evaluate(async () => {
  const save = window.HyperaudioSave;
  await save.saveProject();
  const dir = await save.storage.projectDir(save.library.currentId());
  return JSON.parse(JSON.parse(await save.storage.readText(dir, 'saved.json')).json).provenance;
});

const WORDS = ['alpha', 'one', 'two', 'three', 'four', 'five'];

test.beforeEach(async ({ page }) => {
  await withoutIntroProject(page);
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function' && typeof window.HyperaudioTpme === 'object');
});

test('off by default: nothing about it appears, and an export is what it always was (#668)', async ({ page }) => {
  await makeProject(page, 'interview.wav', WORDS);
  expect(await page.evaluate(() => window.HyperaudioTpme.enabled())).toBe(false);
  await page.evaluate(() => { const m = document.getElementById('info-modal'); m.checked = true; m.dispatchEvent(new Event('change')); });
  expect(await visible(page, '#project-tpme')).toBe(false);
  await page.evaluate(() => { document.getElementById('info-modal').checked = false; });
  for (const id of ['#tpme-export-item', '#tpme-import-item']) expect(await visible(page, id)).toBe(false);

  await setUpExport(page, 'plain', ['export-vtt']);
  expect(await visible(page, '#export-tpme-row')).toBe(false);
  const files = await runExport(page, 2);
  expect(Object.keys(files).sort()).toEqual(['plain.vtt', 'plain.wav']);
});

test('what the engine ran is recorded in the project whether or not this is on (#668)', async ({ page }) => {
  await makeProject(page, 'interview.wav', WORDS);
  const provenance = await savedProvenance(page);
  expect(provenance).toMatchObject({
    engine: 'whisper (local, in your browser)', model: 'Whisper Small (English)',
    modelId: 'onnx-community/whisper-small.en_timestamped', runtime: 'transformers.js', engineVersion: '4.2.0',
    parameters: { language: 'en', word_timestamps: true }, mediaFile: 'interview.wav',
  });

  // ...so a project transcribed with it off gives a complete ASR entry once it is on
  await turnOn(page, { provider: 'Example Archive' });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => document.getElementById('tpme-export-item').click()),
  ]);
  expect(download.suggestedFilename()).toMatch(/^interview-tpme-\d{8}-\d{6}\.json$/);
  const fs = await import('node:fs/promises');
  const entries = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  expect(Array.isArray(entries)).toBe(true);
  expect(entries[0]).toMatchObject({
    application_type: 'ASR', application_name: 'transformers.js', application_version: '4.2.0',
    inference_model: 'onnx-community/whisper-small.en_timestamped', human_review_level: 'machine-generated',
    application_parameters: { language: 'en' }, originating_media_file: 'interview.wav',
    provider: 'Example Archive', transcript_language: ['en'],
  });
});

test('an export writes one entry per file, chained to the ASR step and checksummed (#668)', async ({ page }) => {
  await makeProject(page, 'interview.wav', WORDS);
  await turnOn(page, { provider: 'Example Archive', editor: 'editor@example.org' });
  // a correction: this is now a transcript a person has reviewed
  await page.evaluate(() => {
    const word = document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')[0];
    word.textContent = 'ALPHA ';
    word.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.evaluate(() => { const m = document.getElementById('info-modal'); m.checked = true; m.dispatchEvent(new Event('change')); });
  expect(await visible(page, '#project-tpme')).toBe(true);
  await page.fill('#tpme-media-id', 'cpb-aacip-123');
  await page.locator('#tpme-media-id').dispatchEvent('change');
  await page.evaluate(() => { document.getElementById('info-modal').checked = false; });

  await setUpExport(page, 'interview', ['export-vtt', 'export-srt', 'export-tpme']);
  expect(await visible(page, '#export-tpme-row')).toBe(true);
  // it is counted among the extra files, like the ones the modal knows itself
  expect(await page.textContent('#export-zip-count')).toContain('4 files');
  const files = await runExport(page, 4);

  const name = Object.keys(files).find((n) => /-tpme-/.test(n));
  expect(name).toMatch(/^cpb-aacip-123-tpme-\d{8}-\d{6}\.json$/);
  const entries = JSON.parse(files[name].toString('utf8'));
  expect(entries).toHaveLength(3);
  const [asr, vtt, srt] = entries;
  expect(asr.application_type).toBe('ASR');
  expect(asr.media_id).toBe('cpb-aacip-123');

  expect(vtt).toMatchObject({
    media_id: 'cpb-aacip-123', transcript_id: 'interview.vtt', parent_transcript_id: asr.transcript_id,
    type: 'captions', file_format: 'text/vtt', provider: 'Example Archive',
    human_review_level: 'partially-corrected', human_agent: 'editor@example.org',
    application_name: 'Hyperaudio Lite Editor', application_type: 'transcript editor',
    features: { time_aligned: true, speaker_diarization: true, max_line_chars: 32 },
  });
  expect(srt).toMatchObject({ transcript_id: 'interview.srt', file_format: 'SRT', type: 'captions' });
  // each entry is tied to the exact file beside it
  expect(vtt.transcript_checksum).toBe(sha(files['interview.vtt']));
  expect(srt.transcript_checksum).toBe(sha(files['interview.srt']));
  expect(vtt.application_version).toBe(await page.evaluate(() => document.querySelector('meta[name="version"]').content));
  entries.forEach((e) => expect('application_params' in e).toBe(false));
});

test('untouched machine output is described as a conversion, not a review (#668)', async ({ page }) => {
  await makeProject(page, 'interview.wav', WORDS);
  await turnOn(page, { editor: 'editor@example.org' });
  await setUpExport(page, 'interview', ['export-vtt', 'export-tpme']);
  const files = await runExport(page, 3);
  const entries = JSON.parse(files[Object.keys(files).find((n) => /-tpme-/.test(n))].toString('utf8'));
  expect(entries[1]).toMatchObject({ human_review_level: 'machine-generated', application_type: 'format-conversion' });
  expect(entries[1].human_agent).toBeUndefined();
});

test('Media ID and review level travel with the project (#668)', async ({ page }) => {
  await makeProject(page, 'interview.wav', WORDS);
  await turnOn(page);
  await page.evaluate(() => { const m = document.getElementById('info-modal'); m.checked = true; m.dispatchEvent(new Event('change')); });
  await page.fill('#tpme-media-id', 'cpb-aacip-123');
  await page.locator('#tpme-media-id').dispatchEvent('change');
  await page.fill('#tpme-review-level', 'staff-corrected');
  await page.locator('#tpme-review-level').dispatchEvent('change');
  expect((await savedProvenance(page)).tpme).toEqual({ mediaId: 'cpb-aacip-123', reviewLevel: 'staff-corrected' });

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForFunction(() => typeof window.HyperaudioTpme === 'object');
  await page.evaluate(() => { const m = document.getElementById('info-modal'); m.checked = true; m.dispatchEvent(new Event('change')); });
  await expect(page.locator('#tpme-media-id')).toHaveValue('cpb-aacip-123');
  await expect(page.locator('#tpme-review-level')).toHaveValue('staff-corrected');
  // and clearing a field removes it rather than storing an empty string
  await page.fill('#tpme-review-level', '');
  await page.locator('#tpme-review-level').dispatchEvent('change');
  expect((await savedProvenance(page)).tpme).toEqual({ mediaId: 'cpb-aacip-123' });
});

test('a chain that arrives with a transcript is kept as it came, and ours is appended (#668)', async ({ page }) => {
  // a transcript from elsewhere: no engine ran here
  await makeProject(page, 'interview.wav', WORDS, null);
  await turnOn(page, { provider: 'Example Archive' });
  const theirs = [
    { media_id: 'cpb-aacip-508-125q815826', transcript_id: 'cpb-aacip-508-125q815826-transcript.json',
      parent_transcript_id: 'cpb-aacip-508-125q815826-transcript.mmif', modification_date: '2025-12-19T14:57:52.526575',
      file_format: 'AAPB-transcript-JSON', application_name: 'aapb-transcript-converter', application_params: { max_segment_chars: 110 } },
    { media_id: 'cpb-aacip-508-125q815826', transcript_id: 'cpb-aacip-508-125q815826-transcript.mmif',
      modification_date: '2025-12-19T04:12:27.464650', application_name: 'CLAMS whisper-wrapper', inference_model: 'openai/whisper-large-v3-turbo' },
  ];
  const importTpme = (json) => page.evaluate((text) =>
    { window.__import = window.HyperaudioTpme.importFile(new File([text], 'theirs-tpme.json', { type: 'application/json' })); }, JSON.stringify(json));

  await importTpme(theirs);
  await page.waitForSelector('#project-dialog.modal-open');
  await expect(page.locator('#project-dialog-message')).toContainText('2 entries added');
  await page.click('#project-dialog-confirm');
  expect(await page.evaluate(() => window.__import)).toBe(true);
  // the recording's identifier came with it
  expect(await page.evaluate(() => window.HyperaudioSave.getTpme().mediaId)).toBe('cpb-aacip-508-125q815826');

  // the same file again adds nothing
  await importTpme(theirs);
  await page.waitForSelector('#project-dialog.modal-open');
  await expect(page.locator('#project-dialog-message')).toContainText('already part of');
  await page.click('#project-dialog-confirm');

  // another recording's provenance is questioned, and declined
  await importTpme([{ media_id: 'somebody-else', application_name: 'kaldi' }]);
  await page.waitForSelector('#project-dialog.modal-open');
  await expect(page.locator('#project-dialog-message')).toContainText('somebody-else');
  await page.click('#project-dialog-cancel');
  expect(await page.evaluate(() => window.__import)).toBe(false);
  expect(await page.evaluate(() => window.HyperaudioSave.getTpme().entries.length)).toBe(2);

  // it travels with the project, and comes out first and untouched
  expect((await savedProvenance(page)).tpme.entries).toEqual(theirs);
  await setUpExport(page, 'interview', ['export-vtt', 'export-tpme']);
  const files = await runExport(page, 3);
  const name = Object.keys(files).find((n) => /-tpme-/.test(n));
  expect(name).toMatch(/^cpb-aacip-508-125q815826-tpme-/);
  const entries = JSON.parse(files[name].toString('utf8'));
  expect(entries.slice(0, 2)).toEqual(theirs);
  expect(entries).toHaveLength(3);                                   // no ASR step of ours
  expect(entries[2]).toMatchObject({
    transcript_id: 'interview.vtt', application_name: 'Hyperaudio Lite Editor',
    parent_transcript_id: 'cpb-aacip-508-125q815826-transcript.json',   // the NEWEST of theirs, by date
  });

  // and a JSON file that is not provenance is refused, with nothing added
  await page.evaluate(() => { window.__bad = window.HyperaudioTpme.importFile(new File(['{"words": []}'], 'x.json')); });
  await page.waitForSelector('#project-dialog.modal-open');
  await expect(page.locator('#project-dialog-title-text')).toContainText('Not a provenance file');
  await page.click('#project-dialog-confirm');
  expect(await page.evaluate(() => window.__bad)).toBe(false);
  expect(await page.evaluate(() => window.HyperaudioSave.getTpme().entries.length)).toBe(2);
});

test('opening another project during an export does not change what the file says (#668, #656)', async ({ page }) => {
  const aId = await makeProject(page, 'ladder-a.wav', WORDS);
  const bId = await makeProject(page, 'ladder-b.wav', ['bravo', 'uno', 'due'], Object.assign({}, ENGINE, { modelId: 'deepgram/nova-3', service: 'Deepgram (cloud)' }));
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), aId);
  await expect(page.locator('#hypertranscript')).toContainText('alpha');
  await page.waitForFunction(() => document.getElementById('hyperplayer').readyState >= 1);
  await turnOn(page);

  await setUpExport(page, 'ctx-a', ['export-vtt', 'export-tpme']);
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.getFile;
    window.__release = null;
    FileSystemFileHandle.prototype.getFile = async function (...args) {
      if (window.__release === null && /\.wav$/.test(this.name)) await new Promise((release) => { window.__release = release; });
      return original.apply(this, args);
    };
  });
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.click('#export-start');
  await page.waitForFunction(() => window.__release !== null);
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), bId);
  await expect(page.locator('#hypertranscript')).toContainText('bravo');
  await page.evaluate(() => window.__release());
  await page.waitForFunction(() => document.getElementById('export-status').textContent.startsWith('Done'), null, { timeout: 90000 });
  await expect.poll(() => downloads.length).toBe(3);

  const fs = await import('node:fs/promises');
  const record = downloads.find((d) => /-tpme-/.test(d.suggestedFilename()));
  expect(record.suggestedFilename()).toMatch(/^ladder-a-tpme-/);
  const entries = JSON.parse(await fs.readFile(await record.path(), 'utf8'));
  expect(entries[0]).toMatchObject({ media_id: 'ladder-a', inference_model: 'onnx-community/whisper-small.en_timestamped', originating_media_file: 'ladder-a.wav' });
  expect(JSON.stringify(entries)).not.toContain('ladder-b');
  expect(JSON.stringify(entries)).not.toContain('nova-3');
});

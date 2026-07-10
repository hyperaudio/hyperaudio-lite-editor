// .hyperaudio project save/open (js/hyperaudio-save.js; spec: docs/format/).
// Drives the shipped editor end to end: opens a conformant container built
// with the module's own pure layers, checks that transcript (redactions
// included), captions, options and texts land in the editor; downloads a save
// and verifies the container; reloads and checks the OPFS working-copy restore.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { ladderWav } from './helpers.mjs';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js');
const JSZip = require('jszip');

const FIXTURE_VTT = 'WEBVTT\n\n00:00:00.320 --> 00:00:01.500\nBenvenuti a Hyperaudio\n';

async function buildFixture() {
  const state = {
    generatorVersion: 'e2e',
    created: '2026-07-10T09:00:00Z',
    modified: '2026-07-10T11:30:00Z',
    media: {
      kind: 'original', path: 'media/tone.wav', url: null, filename: 'tone.wav',
      mimeType: 'audio/wav', durationSeconds: 2, sizeBytes: 0,
    },
    options: {
      gapRemoval: { enabled: true, thresholdMs: 700, bufferMs: 150 },
      updateCaptionsFromTranscript: false,
      view: { showSpeakers: true, showTimecodes: false },
    },
    texts: { title: 'E2E Project', language: 'it', summary: 'summary text', topics: ['e2e'] },
    provenance: { engine: 'deepgram', model: 'nova-3', transcribedAt: '2026-07-10T08:55:00Z' },
    hasOriginal: true,
    transcript: {
      words: [
        { start: 0.32, end: 0.84, text: 'Benvenuti' },
        { start: 0.84, end: 1.02, text: 'ehm', struck: true },
        { start: 1.1, end: 1.5, text: 'a' },
      ],
      paragraphs: [{ speaker: 'Maria', start: 0.32, end: 1.5 }],
    },
  };
  return save.zipProject({
    json: save.serializeProjectJson(save.buildProjectJson(state)),
    html: '<article><section><p><span data-m="320" data-d="520">Benvenuti </span></p></section></article>',
    originalJson: JSON.stringify({ words: [{ start: 0.32, end: 0.84, text: 'benvenuti' }], paragraphs: [] }),
    captionsVtt: FIXTURE_VTT,
    media: { name: 'tone.wav', data: ladderWav(2) },
  }, JSZip, 'nodebuffer');
}

// Open the fixture in the live page via the module's hidden input; collect any
// native dialogs (a conformant open must produce none).
async function openFixture(page, testInfo, dialogs) {
  const fixturePath = testInfo.outputPath('fixture.hyperaudio');
  fs.writeFileSync(fixturePath, await buildFixture());
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    dialog.accept();
  });
  await page.setInputFiles('#project-open-input', fixturePath);
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('menu items and hidden input are injected', async ({ page }) => {
  await expect(page.locator('#file-dropdown #project-save-hyperaudio')).toHaveText('Save Project (.hyperaudio)');
  await expect(page.locator('#file-dropdown #project-open-hyperaudio')).toHaveText('Open Project…');
  await expect(page.locator('#project-open-input')).toHaveCount(1);
});

test('opening a .hyperaudio lands transcript, redaction, captions, options and texts', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);

  // transcript: words as spans, the redacted word struck out
  const struck = page.locator('#hypertranscript span[data-m="840"]');
  await expect(struck).toHaveText('ehm ');
  await expect(struck).toHaveCSS('text-decoration-line', 'line-through');
  await expect(page.locator('#hypertranscript .speaker')).toHaveText('[Maria] ');

  // media: playing from the embedded file (object URL, not the demo source)
  const src = await page.evaluate(() => document.querySelector('#hyperplayer').src);
  expect(src).toMatch(/^blob:/);

  // captions: the saved VTT is on the track (curated — updateFromTranscript false)
  const trackSrc = await page.evaluate(() => document.querySelector('#hyperplayer-vtt').src);
  expect(decodeURIComponent(trackSrc.split(',')[1])).toContain('Benvenuti a Hyperaudio');

  // options and texts
  await expect(page.locator('#remove-gaps-enabled')).toBeChecked();
  await expect(page.locator('#remove-gaps-threshold')).toHaveValue('700');
  await expect(page.locator('#save-localstorage-filename')).toHaveValue('E2E Project');
  await expect(page.locator('#summary')).toHaveText('summary text');

  expect(dialogs).toEqual([]); // a conformant file opens without any alert
});

test('saving downloads a conformant container that round-trips', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => document.querySelector('#project-save-hyperaudio').click());
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('E2E Project.hyperaudio');

  const savedPath = testInfo.outputPath('saved.hyperaudio');
  await download.saveAs(savedPath);
  const buf = fs.readFileSync(savedPath);

  // mimetype-first convention: the MIME type is readable at byte offset 38
  expect(buf.toString('ascii', 30, 38)).toBe('mimetype');
  expect(buf.toString('utf8', 38, 38 + save.CONTAINER_MIMETYPE.length)).toBe(save.CONTAINER_MIMETYPE);

  const loaded = await save.unzipProject(new Uint8Array(buf), JSZip);
  expect(loaded.recovered).toBe(false);
  expect(loaded.project.texts.title).toBe('E2E Project');
  expect(loaded.project.media.filename).toBe('tone.wav');
  expect(loaded.mediaData.length).toBeGreaterThan(1000);
  // the redaction survived the full editor round-trip
  expect(loaded.project.transcript.words.some((w) => w.text === 'ehm' && w.struck === true)).toBe(true);
  // the origin travelled along, untouched and struck-free
  expect(JSON.parse(loaded.originalText).words[0].text).toBe('benvenuti');
  expect(loaded.captionsVtt).toContain('Benvenuti a Hyperaudio');
  expect(loaded.project.provenance.originalTranscript).toBe('transcript.original.json');
});

test('the working copy survives a reload (OPFS restore)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);

  // the open seeds OPFS and sets the synchronous boot hint
  await page.waitForFunction(() => localStorage.getItem('hyperaudioWorkPresent') === '1');

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');

  // the restored project replaces the static demo transcript
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  await expect(page.locator('#hypertranscript span[data-m="840"]')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(page.locator('#remove-gaps-threshold')).toHaveValue('700');
  await expect(page.locator('#save-localstorage-filename')).toHaveValue('E2E Project');
  const src = await page.evaluate(() => document.querySelector('#hyperplayer').src);
  expect(src).toMatch(/^blob:/);
});

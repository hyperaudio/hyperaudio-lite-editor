// #677 — Transcribe again, from a Recents row's menu: the project opens and
// the Transcribe dialog opens with that project's media already chosen, in
// every engine's input. The user picks the engine and presses Transcribe,
// and the result lands as every transcription does, a new project named
// after the media, with the project transcribed again left exactly as it
// was. A project with no media, or an engine already running, leaves the
// item disabled with the reason as its tooltip.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { ladderWav, pollPage, withoutIntroProject } from './helpers.mjs';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js');
const JSZip = require('jszip');

const LINK_URL = 'https://media.example.com/talks/keynote.wav';

let fixtureEdits = 0;
async function buildFixture(title, media) {
  fixtureEdits += 1;
  const state = {
    generatorVersion: 'e2e',
    created: '2026-07-10T09:00:00Z',
    modified: new Date(Date.parse('2026-07-10T11:30:00Z') + fixtureEdits * 60000).toISOString(),
    media: media === 'link'
      ? { kind: 'link', path: null, url: LINK_URL, filename: 'keynote.wav', mimeType: '', durationSeconds: 2, sizeBytes: 0 }
      : media === 'none'
        ? { kind: 'none', path: null, url: null, filename: '', mimeType: '', durationSeconds: 0, sizeBytes: 0 }
        : { kind: 'original', path: 'media/tone.wav', url: null, filename: 'tone.wav', mimeType: 'audio/wav', durationSeconds: 2, sizeBytes: 0 },
    options: {
      gapRemoval: { enabled: false, thresholdMs: 500, bufferMs: 100 },
      updateCaptionsFromTranscript: true,
      view: { showSpeakers: true, showTimecodes: false },
    },
    texts: { title, language: 'it', summary: '', topics: [] },
    provenance: { engine: 'deepgram', model: 'nova-3', transcribedAt: '2026-07-10T08:55:00Z' },
    hasOriginal: false,
    transcript: {
      words: [
        { start: 0.32, end: 0.84, text: 'Benvenuti' },
        { start: 1.1, end: 1.5, text: 'a' },
      ],
      paragraphs: [{ speaker: 'Maria', start: 0.32, end: 1.5 }],
    },
  };
  return save.zipProject({
    json: save.serializeProjectJson(save.buildProjectJson(state)),
    html: '<article><section><p><span data-m="320" data-d="520">Benvenuti </span><span data-m="1100" data-d="400">a </span></p></section></article>',
    media: media === 'original' ? { name: 'tone.wav', data: ladderWav(2) } : null,
  }, JSZip, 'nodebuffer');
}

async function openProject(page, testInfo, title, media) {
  const fixturePath = testInfo.outputPath(title.replace(/\s+/g, '-') + '.hyperaudio');
  fs.writeFileSync(fixturePath, await buildFixture(title, media));
  await page.evaluate(() => { document.getElementById('project-open-input').value = ''; });
  await page.setInputFiles('#project-open-input', fixturePath);
  // a link project opens behind a note that it plays from its URL
  if (media === 'link') await page.click('#project-dialog-confirm');
  await expect(page.locator('#file-picker .file-item.active')).toHaveText(title);
}

const row = (page, title) => page.locator('#file-picker .file-item', { hasText: title });

async function openKebab(page, title) {
  const item = row(page, title);
  await item.hover();
  await item.locator('..').locator('.recents-kebab').click();
  await expect(page.locator('#recents-menu')).toBeVisible();
}

const again = (page) => page.locator('#recents-menu .recents-menu-transcribe');
const library = (page) => page.evaluate(() => window.HyperaudioSave.library.list());

const FILE_INPUTS = ['#file-input', '#parakeet-file-input', '#deepgram-file', '#assemblyai-file', '#parakeet-hf-file'];
const URL_INPUTS = ['#media', '#parakeet-media', '#deepgram-media', '#assemblyai-media', '#parakeet-hf-media'];

// the dialog's inputs, as the engines will read them at submit
const chosen = (page) => page.evaluate(([files, urls]) => ({
  files: files.map((s) => [...document.querySelector(s).files].map((f) => f.name)),
  urls: urls.map((s) => document.querySelector(s).value),
  open: [...document.querySelectorAll('details.url-source')].map((d) => d.open),
  modal: document.getElementById('transcribe-modal').checked,
  sessionFile: (window.HyperaudioSave.sessionMediaFile() || {}).name || null,
}), [FILE_INPUTS, URL_INPUTS]);

// Deepgram's answer for the second pass
const RESPONSE = {
  results: {
    channels: [{
      detected_language: 'en',
      alternatives: [{
        transcript: 'Welcome back.',
        words: [
          { word: 'welcome', punctuated_word: 'Welcome', start: 0.1, end: 0.6, speaker: 0 },
          { word: 'back', punctuated_word: 'back.', start: 0.7, end: 1.1, speaker: 0 },
        ],
      }],
    }],
  },
};

test.beforeEach(async ({ page }) => {
  await withoutIntroProject(page);
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('a project with its media file: the dialog opens with the file in every engine\'s input, and the second pass is a new project', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Interview', 'original');
  await openProject(page, testInfo, 'Other work', 'original');   // so Interview is not the open project

  await openKebab(page, 'Interview');
  await expect(again(page)).toBeEnabled();
  await again(page).click();

  // the project opened, and the dialog holds its media
  await expect(page.locator('#file-picker .file-item.active')).toHaveText('Interview');
  await expect.poll(() => chosen(page).then((c) => c.modal)).toBe(true);
  const c = await chosen(page);
  expect(c.files).toEqual(FILE_INPUTS.map(() => ['tone.wav']));
  expect(c.urls).toEqual(URL_INPUTS.map(() => ''));
  expect(c.sessionFile).toBe('tone.wav');

  // the user chooses Deepgram and presses Transcribe
  await page.route('https://api.deepgram.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESPONSE) }));
  const before = (await library(page)).length;
  await page.evaluate(() => {
    document.getElementById('service-cloud').checked = true;
    document.querySelector('input[name="cloud_tabs"][aria-label="Deepgram"]').checked = true;
    const token = document.querySelector('#token');
    token.value = 'test-token';
    token.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#transcribe-btn')).not.toHaveClass(/btn-disabled/);
  await page.locator('#transcribe-btn').click();

  await expect(page.locator('#hypertranscript')).toContainText('Welcome back.');
  await pollPage(page, async (n) => (await window.HyperaudioSave.library.list()).length === n + 1, before);
  const names = (await library(page)).map((p) => p.name);
  expect(names).toContain('tone.wav');     // the new project, named after the media
  expect(names).toContain('Interview');    // the one transcribed again, still there
  expect(names).toContain('Other work');

  // ... and untouched: it still reads as it did
  await row(page, 'Interview').click();
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  await expect(page.locator('#hypertranscript')).not.toContainText('Welcome');
});

test('a project that plays from a link: the dialog opens with the URL in every engine\'s field', async ({ page }, testInfo) => {
  // the link plays, so no offer to re-attach media stands in the way
  await page.route(LINK_URL, (route) => route.fulfill({ body: ladderWav(2), contentType: 'audio/wav' }));
  await openProject(page, testInfo, 'Keynote', 'link');
  await openKebab(page, 'Keynote');
  await expect(again(page)).toBeEnabled();
  await again(page).click();

  await expect.poll(() => chosen(page).then((c) => c.modal)).toBe(true);
  const c = await chosen(page);
  expect(c.urls).toEqual(URL_INPUTS.map(() => LINK_URL));
  expect(c.files).toEqual(FILE_INPUTS.map(() => []));
  expect(c.open.length).toBeGreaterThan(0);
  expect(c.open.every((o) => o === true)).toBe(true);
  // the engines heard the field change: Deepgram's button is ready to go
  await expect(page.locator('#transcribe-btn')).not.toHaveClass(/btn-disabled/);
});

test('a project with no media: the item is there, disabled, and says why', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Notes only', 'none');
  await openKebab(page, 'Notes only');
  await expect(again(page)).toBeDisabled();
  await expect(again(page)).toHaveAttribute('title', 'This project has no media to transcribe');
  await expect(page.locator('#recents-menu .recents-menu-duplicate')).toBeEnabled();
  expect(await page.evaluate(() => document.getElementById('transcribe-modal').checked)).toBe(false);
});

test('while an engine is running the item is disabled too', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Interview', 'original');
  // an engine starts, exactly as they all do
  const wav = testInfo.outputPath('running.wav');
  fs.writeFileSync(wav, ladderWav(1));
  await page.setInputFiles('#file-input', wav);
  await page.evaluate(async (bytes) => {
    const player = document.getElementById('hyperplayer');
    player.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }));
    document.querySelector('#hypertranscript').innerHTML =
      '<div class="vertically-centre"><center><span class="transcribing-msg">Transcribing…</span></center></div>';
    setTranscriptBusy(true);
  }, [...fs.readFileSync(wav)]);
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(1);

  await openKebab(page, 'Interview');
  await expect(again(page)).toBeDisabled();
  await expect(again(page)).toHaveAttribute('title', 'A transcription is already running');
});

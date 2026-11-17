// #809 — a file left in a transcribe dialog's input from an earlier run is
// sent again by the engine when the user presses Transcribe without choosing
// it again. No change event fires for it, and the new project used to take
// the name and the media of the project that was open instead. The input is
// read again when a transcribe button is pressed.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { ladderWav, withoutIntroProject } from './helpers.mjs';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js');
const JSZip = require('jszip');

async function openProject(page, testInfo, title) {
  const state = {
    generatorVersion: 'e2e',
    created: '2026-07-10T09:00:00Z',
    modified: '2026-07-10T11:30:00Z',
    media: { kind: 'original', path: 'media/tone.wav', url: null, filename: 'tone.wav', mimeType: 'audio/wav', durationSeconds: 2, sizeBytes: 0 },
    options: { gapRemoval: { enabled: false, thresholdMs: 500, bufferMs: 100 }, updateCaptionsFromTranscript: true, view: { showSpeakers: true, showTimecodes: false } },
    texts: { title, language: 'en', summary: '', topics: [] },
    provenance: { engine: 'deepgram', model: 'nova-3', transcribedAt: '2026-07-10T08:55:00Z' },
    hasOriginal: false,
    transcript: { words: [{ start: 0.3, end: 0.8, text: 'Hello' }], paragraphs: [{ start: 0.3, end: 0.8 }] },
  };
  const zip = await save.zipProject({
    json: save.serializeProjectJson(save.buildProjectJson(state)),
    html: '<article><section><p><span data-m="300" data-d="500">Hello </span></p></section></article>',
    media: { name: 'tone.wav', data: ladderWav(2) },
  }, JSZip, 'nodebuffer');
  const path = testInfo.outputPath(title.replace(/\s+/g, '-') + '.hyperaudio');
  fs.writeFileSync(path, zip);
  await page.evaluate(() => { document.getElementById('project-open-input').value = ''; });
  await page.setInputFiles('#project-open-input', path);
  await expect(page.locator('#file-picker .file-item.active')).toHaveText(title);
}

const RESPONSE = {
  results: { channels: [{ detected_language: 'en', alternatives: [{
    transcript: 'Welcome back.',
    words: [
      { word: 'welcome', punctuated_word: 'Welcome', start: 0.1, end: 0.6, speaker: 0 },
      { word: 'back', punctuated_word: 'back.', start: 0.7, end: 1.1, speaker: 0 },
    ],
  }] }] },
};

async function pressTranscribe(page) {
  await page.click('#new-transcription-btn');
  await page.evaluate(() => {
    document.getElementById('service-cloud').checked = true;
    document.querySelector('input[name="cloud_tabs"][aria-label="Deepgram"]').checked = true;
    const token = document.querySelector('#token');
    token.value = 'test-token';
    token.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#transcribe-btn')).not.toHaveClass(/btn-disabled/);
  await page.locator('#transcribe-btn').click();
}

const names = async (page) => (await page.evaluate(() => window.HyperaudioSave.library.list())).map((p) => p.name).sort();
const sessionFile = (page) => page.evaluate(() => (window.HyperaudioSave.sessionMediaFile() || {}).name || null);

test.beforeEach(async ({ page }) => {
  await withoutIntroProject(page);
  await page.route('https://api.deepgram.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESPONSE) }));
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('a file left in the input from an earlier run names the new project and is its media (#809)', async ({ page }, testInfo) => {
  // first run: interview.wav chosen in the Deepgram tab
  await page.setInputFiles('#deepgram-file', { name: 'interview.wav', mimeType: 'audio/wav', buffer: ladderWav(2) });
  await pressTranscribe(page);
  await expect.poll(() => names(page)).toEqual(['interview.wav']);

  // another project opens, with its own media
  await openProject(page, testInfo, 'Other work');
  expect(await sessionFile(page)).toBe('tone.wav');

  // the dialog still holds interview.wav, and the user transcribes it as it stands
  const left = await page.evaluate(() => [...document.querySelector('#deepgram-file').files].map((f) => f.name));
  if (left.length === 0) {
    // the input was emptied after the first run: put the file back without a change event
    await page.evaluate(async () => {
      const input = document.querySelector('#deepgram-file');
      const t = new DataTransfer();
      t.items.add(new File([new Uint8Array(64)], 'interview.wav', { type: 'audio/wav' }));
      input.files = t.files;
    });
  } else {
    expect(left).toEqual(['interview.wav']);
  }
  await pressTranscribe(page);
  await expect.poll(() => names(page)).toEqual(['Other work', 'interview.wav', 'interview.wav']);
  // the new project is on screen with interview.wav as its media, not tone.wav
  await expect(page.locator('#file-picker .file-item.active')).toHaveText('interview.wav');
  expect(await sessionFile(page)).toBe('interview.wav');
});

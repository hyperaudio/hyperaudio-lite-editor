// #677 — Retranscribe, from a Recents row's menu: behind a confirm, the
// project opens and the Transcribe dialog opens with that project's media
// already chosen, in every engine's input. The user picks the engine and
// presses Transcribe, and the result REPLACES the project's transcript, with
// the project's name and media kept, whether it finishes on screen or while
// another project is open. A project edited while its transcription runs is
// left alone and the result is kept as a new project. Closing the dialog
// without transcribing undoes the arrangement. A project with no media, or
// an engine already running, leaves the item disabled with the reason as
// its tooltip.
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

// a project's own row (the in-progress row has no id)
const row = (page, title) => page.locator('#file-picker .file-item[data-id]', { hasText: title });

async function openKebab(page, title) {
  const item = row(page, title);
  await item.hover();
  await item.locator('..').locator('.recents-kebab').click();
  await expect(page.locator('#recents-menu')).toBeVisible();
}

const item = (page) => page.locator('#recents-menu .recents-menu-transcribe');
const library = (page) => page.evaluate(() => window.HyperaudioSave.library.list());
const names = async (page) => (await library(page)).map((p) => p.name).sort();
const entryOf = async (page, name) => (await library(page)).find((p) => p.name === name);
const modalOpen = (page) => page.evaluate(() => document.getElementById('transcribe-modal').checked);
const hasDraft = (page, id) => page.evaluate(async (id) => {
  try { const d = await window.HyperaudioSave.storage.projectDir(id); await d.getFileHandle('draft.json'); return true; } catch (e) { return false; }
}, id);

// the menu item, then the confirm: "Retranscribe" goes ahead
async function retranscribe(page, title) {
  await openKebab(page, title);
  await expect(item(page)).toBeEnabled();
  await item(page).click();
  await expect(page.locator('#project-dialog-message')).toContainText('replaces the transcript of “' + title + '”');
  await page.click('#project-dialog-confirm');
  await expect.poll(() => modalOpen(page)).toBe(true);
}

const FILE_INPUTS = ['#file-input', '#parakeet-file-input', '#deepgram-file', '#assemblyai-file', '#parakeet-hf-file'];
const URL_INPUTS = ['#media', '#parakeet-media', '#deepgram-media', '#assemblyai-media', '#parakeet-hf-media'];

// the dialog's inputs, as the engines will read them at submit
const chosen = (page) => page.evaluate(([files, urls]) => ({
  files: files.map((s) => [...document.querySelector(s).files].map((f) => f.name)),
  urls: urls.map((s) => document.querySelector(s).value),
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

// Deepgram, answering at once or when released
async function mockDeepgram(page) {
  let release = null;
  const held = new Promise((r) => { release = r; });
  await page.route('https://api.deepgram.com/**', async (route) => {
    if (release !== null) await held;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESPONSE) });
  });
  return { hold: () => {}, release: () => { const r = release; release = null; r(); }, answerAtOnce: () => { release = null; } };
}

// the user chooses Deepgram and presses Transcribe
async function pressTranscribe(page) {
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

test.beforeEach(async ({ page }) => {
  await withoutIntroProject(page);
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('the dialog opens with the file in every engine\'s input, and the result replaces the project\'s transcript', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Interview', 'original');
  await openProject(page, testInfo, 'Other work', 'original');   // so Interview is not the open project
  const interview = (await entryOf(page, 'Interview')).id;

  await retranscribe(page, 'Interview');
  await expect(page.locator('#file-picker .file-item.active')).toHaveText('Interview');
  const c = await chosen(page);
  expect(c.files).toEqual(FILE_INPUTS.map(() => ['tone.wav']));
  expect(c.urls).toEqual(URL_INPUTS.map(() => ''));
  expect(c.sessionFile).toBe('tone.wav');

  const deepgram = await mockDeepgram(page);
  deepgram.answerAtOnce();
  await pressTranscribe(page);
  await expect(page.locator('#hypertranscript')).toContainText('Welcome back.');

  // the same two projects: Interview, under its name, with its media, now
  // reads as the second pass, and carries no draft of the first
  await pollPage(page, async (id) => {
    const e = (await window.HyperaudioSave.library.list()).find((p) => p.id === id);
    return !!(e && e.lastSavedAt > Date.parse('2026-07-10T11:30:00Z') && e.lastDraftAt === 0);
  }, interview);
  expect(await names(page)).toEqual(['Interview', 'Other work']);
  const entry = await entryOf(page, 'Interview');
  expect(entry.id).toBe(interview);
  expect(entry.media).toMatchObject({ kind: 'original', filename: 'tone.wav' });
  expect(await hasDraft(page, interview)).toBe(false);
  await row(page, 'Other work').click();
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  await row(page, 'Interview').click();
  await expect(page.locator('#hypertranscript')).toContainText('Welcome back.');
  await expect(page.locator('#hypertranscript')).not.toContainText('Benvenuti');
});

test('cancelling the confirm opens nothing', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Interview', 'original');
  await openProject(page, testInfo, 'Other work', 'original');
  await openKebab(page, 'Interview');
  await item(page).click();
  await expect(page.locator('#project-dialog-message')).toContainText('Duplicate the project first');
  await page.click('#project-dialog-cancel');
  await expect(page.locator('#file-picker .file-item.active')).toHaveText('Other work');
  expect(await modalOpen(page)).toBe(false);
});

test('closing the dialog instead of transcribing: the next transcription is a new project again', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Interview', 'original');
  await retranscribe(page, 'Interview');
  await page.locator('label[for="transcribe-modal"][aria-label="Close"]').click();
  await expect.poll(() => modalOpen(page)).toBe(false);

  // a transcription of another file, started as usual
  const wav = testInfo.outputPath('fresh.wav');
  fs.writeFileSync(wav, ladderWav(1));
  await page.evaluate(() => { document.getElementById('transcribe-modal').checked = true; });
  await page.setInputFiles('#deepgram-file', wav);
  const deepgram = await mockDeepgram(page);
  deepgram.answerAtOnce();
  await pressTranscribe(page);
  await expect(page.locator('#hypertranscript')).toContainText('Welcome back.');
  await pollPage(page, async () => (await window.HyperaudioSave.library.list()).length === 2);
  expect(await names(page)).toEqual(['Interview', 'fresh.wav']);
  await row(page, 'Interview').click();
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
});

test('finishing while another project is open replaces the project in Recents and leaves the screen alone', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Interview', 'original');
  await openProject(page, testInfo, 'Other work', 'original');
  const interview = (await entryOf(page, 'Interview')).id;
  await retranscribe(page, 'Interview');
  const deepgram = await mockDeepgram(page);
  await pressTranscribe(page);
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(1);
  await expect(page.locator('.recents-row-transcribing')).toContainText('Retranscribing Interview');

  // away to the other project while it runs
  await row(page, 'Other work').click();
  await expect(page.locator('#file-picker .file-item.active')).toHaveText('Other work');
  deepgram.release();

  await expect(page.locator('#transcript-ready-notice')).toContainText('“Interview” transcript is ready');
  await expect(page.locator('#file-picker .file-item.active')).toHaveText('Other work');
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  expect(await names(page)).toEqual(['Interview', 'Other work']);
  expect((await entryOf(page, 'Interview')).id).toBe(interview);
  await row(page, 'Interview').click();
  await expect(page.locator('#hypertranscript')).toContainText('Welcome back.');
  await expect(page.locator('#hypertranscript')).not.toContainText('Benvenuti');
});

test('back on the project from its row, with no edit, the result lands on screen and replaces it', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Interview', 'original');
  await openProject(page, testInfo, 'Other work', 'original');
  const interview = (await entryOf(page, 'Interview')).id;
  await retranscribe(page, 'Interview');
  const deepgram = await mockDeepgram(page);
  await pressTranscribe(page);
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(1);

  // the project's own row, while the loader has the screen
  await row(page, 'Interview').click();
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  await expect(page.locator('#file-picker .file-item.active')).toHaveText('Interview');
  deepgram.release();

  await expect(page.locator('#hypertranscript')).toContainText('Welcome back.');
  await expect(page.locator('#hypertranscript')).not.toContainText('Benvenuti');
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(0);
  expect(await page.locator('#transcript-ready-notice').count()).toBe(0);
  await pollPage(page, async (id) => {
    const e = (await window.HyperaudioSave.library.list()).find((p) => p.id === id);
    return !!(e && e.lastSavedAt > Date.parse('2026-07-10T11:30:00Z') && e.lastDraftAt === 0);
  }, interview);
  expect(await names(page)).toEqual(['Interview', 'Other work']);
  expect((await entryOf(page, 'Interview')).id).toBe(interview);
  await row(page, 'Other work').click();
  await row(page, 'Interview').click();
  await expect(page.locator('#hypertranscript')).toContainText('Welcome back.');
});

test('a project edited while its transcription runs is left alone, and the result is a new project', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Interview', 'original');
  const interview = (await entryOf(page, 'Interview')).id;
  await retranscribe(page, 'Interview');
  const deepgram = await mockDeepgram(page);
  await pressTranscribe(page);
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(1);

  // back to the project from its row, and a correction typed into it
  await row(page, 'Interview').click();
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  await page.locator('#hypertranscript span[data-m]').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await pollPage(page, async (id) => {
    const e = (await window.HyperaudioSave.library.list()).find((p) => p.id === id);
    return !!(e && e.lastDraftAt > 0);
  }, interview);
  deepgram.release();

  await expect(page.locator('#transcript-ready-notice')).toContainText('“Interview” was edited meanwhile');
  await pollPage(page, async () => (await window.HyperaudioSave.library.list()).length === 2);
  expect(await names(page)).toEqual(['Interview', 'tone.wav']);
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  await expect(page.locator('#hypertranscript')).not.toContainText('Welcome');
  await row(page, 'tone.wav').click();
  await expect(page.locator('#hypertranscript')).toContainText('Welcome back.');
});

test('a project that plays from a link keeps its link', async ({ page }, testInfo) => {
  // the link plays, so no offer to re-attach media stands in the way
  await page.route(LINK_URL, (route) => route.fulfill({ body: ladderWav(2), contentType: 'audio/wav' }));
  await openProject(page, testInfo, 'Keynote', 'link');
  const keynote = (await entryOf(page, 'Keynote')).id;
  await retranscribe(page, 'Keynote');
  const c = await chosen(page);
  expect(c.urls).toEqual(URL_INPUTS.map(() => LINK_URL));
  expect(c.files).toEqual(FILE_INPUTS.map(() => []));

  const deepgram = await mockDeepgram(page);
  deepgram.answerAtOnce();
  await pressTranscribe(page);
  await expect(page.locator('#hypertranscript')).toContainText('Welcome back.');
  await pollPage(page, async (id) => {
    const e = (await window.HyperaudioSave.library.list()).find((p) => p.id === id);
    return !!(e && e.lastSavedAt > Date.parse('2026-07-10T11:30:00Z'));
  }, keynote);
  expect(await names(page)).toEqual(['Keynote']);
  expect(await entryOf(page, 'Keynote')).toMatchObject({ id: keynote, media: { kind: 'link', url: LINK_URL } });
});

test('a project with no media: the item is there, disabled, and says why', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Notes only', 'none');
  await openKebab(page, 'Notes only');
  await expect(item(page)).toBeDisabled();
  await expect(item(page)).toHaveAttribute('title', 'This project has no media to transcribe');
  await expect(page.locator('#recents-menu .recents-menu-duplicate')).toBeEnabled();
  expect(await modalOpen(page)).toBe(false);
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
  await expect(item(page)).toBeDisabled();
  await expect(item(page)).toHaveAttribute('title', 'A transcription is already running');
});

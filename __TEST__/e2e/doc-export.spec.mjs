// Transcript document exports (#467): the TXT/MD menu items drive the shipped
// editor end to end — a project with a speaker and a redacted word exports to
// clean rendered documents named from the project title.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { ladderWav } from './helpers.mjs';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js');
const JSZip = require('jszip');

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
      gapRemoval: { enabled: false, thresholdMs: 500, bufferMs: 100 },
      updateCaptionsFromTranscript: true,
      view: { showSpeakers: true, showTimecodes: false },
    },
    texts: { title: 'Doc Export Project', language: 'it', summary: '', topics: [] },
    hasOriginal: false,
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
    media: { name: 'tone.wav', data: ladderWav(2) },
  }, JSZip, 'nodebuffer');
}

async function exportVia(page, itemId, testInfo, saveName) {
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate((id) => document.getElementById(id).click(), itemId);
  const download = await downloadPromise;
  const outPath = testInfo.outputPath(saveName);
  await download.saveAs(outPath);
  return { name: download.suggestedFilename(), text: fs.readFileSync(outPath, 'utf8') };
}

test.beforeEach(async ({ page }, testInfo) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const fixturePath = testInfo.outputPath('fixture.hyperaudio');
  fs.writeFileSync(fixturePath, await buildFixture());
  await page.setInputFiles('#project-open-input', fixturePath);
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
});

test('the menu carries both items directly under Export Project', async ({ page }) => {
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('#file-exportimport-submenu ul a')].map((a) => a.id).slice(0, 5));
  expect(order).toEqual([
    'project-open-hyperaudio', 'project-export-hyperaudio',
    'export-transcript-txt', 'export-transcript-md', 'export-transcript-docx',
  ]);
});

test('TXT export: speaker prefix, redacted word dropped, title-derived filename', async ({ page }, testInfo) => {
  const out = await exportVia(page, 'export-transcript-txt', testInfo, 'out.txt');
  expect(out.name).toBe('Doc Export Project.txt');
  expect(out.text).toBe('Maria: Benvenuti a\n'); // "ehm" is struck: it must not survive
});

test('MD export: bold speaker, same redaction semantics', async ({ page }, testInfo) => {
  const out = await exportVia(page, 'export-transcript-md', testInfo, 'out.md');
  expect(out.name).toBe('Doc Export Project.md');
  expect(out.text).toBe('**Maria:** Benvenuti a\n');
});

test('DOCX export: a valid package with bold speaker run, redaction dropped', async ({ page }, testInfo) => {
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => document.getElementById('export-transcript-docx').click());
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Doc Export Project.docx');
  const outPath = testInfo.outputPath('out.docx');
  await download.saveAs(outPath);
  const zip = await JSZip.loadAsync(fs.readFileSync(outPath));
  const docXml = await zip.file('word/document.xml').async('string');
  expect(docXml).toContain('<w:t xml:space="preserve">Maria: </w:t>');
  expect(docXml).toContain('Benvenuti a');
  expect(docXml).not.toContain('ehm');
});

test('exports follow edits: a new word appears, a newly struck word disappears', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'Willkommen ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const out = await exportVia(page, 'export-transcript-txt', testInfo, 'edited.txt');
  expect(out.text).toBe('Maria: Willkommen a\n');
});

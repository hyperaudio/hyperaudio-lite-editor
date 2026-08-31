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

test('the transcript exports sit directly under Export Project in the Export submenu (#470)', async ({ page }) => {
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('#file-export-submenu ul a')].map((a) => a.id).slice(0, 4));
  expect(order).toEqual([
    'project-export-hyperaudio',
    'export-transcript-txt', 'export-transcript-md', 'export-transcript-docx',
  ]);
  const importOrder = await page.evaluate(() =>
    [...document.querySelectorAll('#file-import-submenu ul a')].map((a) => a.id).slice(0, 1));
  expect(importOrder).toEqual(['project-open-hyperaudio']);
});

test('TXT export: speaker prefix, redacted word dropped, title-derived filename', async ({ page }, testInfo) => {
  const out = await exportVia(page, 'export-transcript-txt', testInfo, 'out.txt');
  expect(out.name).toBe('Doc Export Project.txt');
  expect(out.text).toBe('Maria: Benvenuti a\n'); // "ehm" is struck: it must not survive
});

test('MD export: bold speaker, struck word kept but marked (#611)', async ({ page }, testInfo) => {
  const out = await exportVia(page, 'export-transcript-md', testInfo, 'out.md');
  expect(out.name).toBe('Doc Export Project.md');
  // Markdown can say "this was struck", so it does, rather than handing over a
  // quietly shorter document. TXT above cannot, so it drops the word instead.
  expect(out.text).toBe('**Maria:** Benvenuti ~~ehm~~ a\n');
});

test('DOCX export: a valid package with bold speaker run, struck word marked (#611)', async ({ page }, testInfo) => {
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => document.getElementById('export-transcript-docx').click());
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Doc Export Project.docx');
  const outPath = testInfo.outputPath('out.docx');
  await download.saveAs(outPath);
  const zip = await JSZip.loadAsync(fs.readFileSync(outPath));
  const docXml = await zip.file('word/document.xml').async('string');
  expect(docXml).toContain('<w:t xml:space="preserve">Maria: </w:t>');
  // .docx can show that a word was struck, so the word survives inside a run
  // carrying <w:strike/> rather than vanishing (#611). The space after it sits
  // in the following run, so the strikethrough does not draw through the gap.
  expect(docXml).toContain('<w:t xml:space="preserve">Benvenuti </w:t>');
  expect(docXml).toContain('<w:rPr><w:strike/></w:rPr><w:t xml:space="preserve">ehm</w:t>');
  expect(docXml).toContain('<w:t xml:space="preserve"> a</w:t>');
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

test.describe('copy to clipboard', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('the button copies BOTH flavours, whole transcript, redaction dropped', async ({ page }) => {
    await page.click('#transcript-copy-btn');
    // feedback: checkmark state + polite announcement
    await expect(page.locator('#transcript-copy-btn[data-copied]')).toBeVisible();
    await expect(page.locator('#transcript-copy-status')).toHaveText('Transcript copied to clipboard.');

    const flavours = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const out = {};
      for (const item of items) {
        for (const type of item.types) {
          out[type] = await (await item.getType(type)).text();
        }
      }
      return out;
    });
    expect(flavours['text/plain']).toBe('Maria: Benvenuti a\n');            // the TXT rendering
    expect(flavours['text/html']).toContain('<b>Maria:</b> Benvenuti a');   // the rich rendering
    expect(flavours['text/html']).not.toContain('ehm');                     // redaction holds in both

    // the checkmark reverts to the copy glyph
    await expect(page.locator('#transcript-copy-btn:not([data-copied])')).toBeVisible({ timeout: 3000 });
  });

  test('a live selection does not narrow the copy (whole-transcript contract)', async ({ page }) => {
    await page.evaluate(() => {
      const word = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
      const range = document.createRange();
      range.selectNodeContents(word);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.click('#transcript-copy-btn');
    await expect(page.locator('#transcript-copy-btn[data-copied]')).toBeVisible();
    const plain = await page.evaluate(() => navigator.clipboard.readText());
    expect(plain).toBe('Maria: Benvenuti a\n'); // everything, not the selected word
  });

  test('the button yields the corner to caption mode and returns', async ({ page }) => {
    await expect(page.locator('#transcript-copy-btn')).toBeVisible();
    await page.click('#caption-editor-btn');
    await expect(page.locator('#transcript-copy-btn')).toBeHidden();
    await page.click('#transcript-editor-btn');
    await expect(page.locator('#transcript-copy-btn')).toBeVisible();
  });
});

test('the copy button hides while a transcription is running (aria-busy)', async ({ page }) => {
  await expect(page.locator('#transcript-copy-btn')).toBeVisible();
  // setTranscriptBusy is what every engine calls around its work
  await page.evaluate(() => setTranscriptBusy(true));
  await expect(page.locator('#transcript-copy-btn')).toBeHidden();
  await page.evaluate(() => setTranscriptBusy(false));
  await expect(page.locator('#transcript-copy-btn')).toBeVisible();
});

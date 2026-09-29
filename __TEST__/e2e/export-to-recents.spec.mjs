// #693 — Export media's Add to Recents: the render becomes a project of its
// own in the library, without opening it, and a reload stays on the project
// that was open.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { ladderWav } from './helpers.mjs';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js');
const JSZip = require('jszip');

// 30 one-second words, "w0" … "w29"; w15 struck out
async function buildFixture() {
  const words = Array.from({ length: 30 }, (_, i) => Object.assign(
    { start: i, end: i + 1, text: `w${i}` }, i === 15 ? { struck: true } : {}));
  const state = {
    generatorVersion: 'e2e', created: '2026-09-27T09:00:00Z', modified: '2026-09-27T09:00:00Z',
    media: { kind: 'original', path: 'media/tone.wav', url: null, filename: 'tone.wav', mimeType: 'audio/wav', durationSeconds: 30, sizeBytes: 0 },
    options: { gapRemoval: { enabled: false, thresholdMs: 500, bufferMs: 100 }, updateCaptionsFromTranscript: true, view: { showSpeakers: true, showTimecodes: false } },
    texts: { title: 'Recents Source', language: 'en', summary: '', topics: [] },
    hasOriginal: false,
    transcript: { words, paragraphs: [{ speaker: '', start: 0, end: 30 }] },
  };
  const html = '<article><section><p>' + words.map((w) =>
    `<span data-m="${w.start * 1000}" data-d="1000"${w.struck ? ' style="text-decoration: line-through;"' : ''}>${w.text} </span>`).join('') + '</p></section></article>';
  return save.zipProject({
    json: save.serializeProjectJson(save.buildProjectJson(state)),
    html,
    media: { name: 'tone.wav', data: ladderWav(30, 8000) },
  }, JSZip, 'nodebuffer');
}

const openFixture = async (page, testInfo) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const fixturePath = testInfo.outputPath('fixture.hyperaudio');
  fs.writeFileSync(fixturePath, await buildFixture());
  await page.setInputFiles('#project-open-input', fixturePath);
  await expect(page.locator('#hypertranscript')).toContainText('w29');
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 1 && p.duration > 29;
  });
  await expect.poll(async () => (await page.evaluate(() => window.HyperaudioSave.library.list()))
    .some((p) => p.name === 'Recents Source')).toBe(true);
};

const select = (page, from, to) => page.evaluate(([a, b]) => {
  const spans = document.querySelectorAll('#hypertranscript [data-m]');
  const range = document.createRange();
  range.setStart(spans[a].firstChild, 0);
  range.setEnd(spans[b].firstChild, spans[b].textContent.trimEnd().length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}, [from, to]);

const openExport = async (page) => {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));   // selectionchange is async
  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
};

test('Add to Recents is offered beside Download, and hides what only downloads use', async ({ page }, testInfo) => {
  await openFixture(page, testInfo);
  await openExport(page);
  await expect(page.locator('#export-dest-row')).toBeVisible();
  expect(await page.evaluate(() => document.getElementById('export-dest-download').checked)).toBe(true);
  await page.evaluate(() => {
    const c = document.getElementById('export-retime');
    c.checked = true; c.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#export-extras')).toBeVisible();
  await page.check('#export-dest-recents');
  await expect(page.locator('#export-extras')).toBeHidden();
  await expect(page.locator('#export-zip-row')).toBeHidden();
  await expect(page.locator('#export-start')).toHaveText('ADD TO RECENTS');
  await page.check('#export-dest-download');
  await expect(page.locator('#export-extras')).toBeVisible();
  await expect(page.locator('#export-start')).toHaveText('EXPORT');
});

test('a clip added to Recents is a project of its own; the open project stays open, and a reload stays on it', async ({ page }, testInfo) => {
  await openFixture(page, testInfo);
  const sourceId = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await select(page, 10, 19);
  await openExport(page);
  await page.selectOption('#export-format', 'wav');
  await page.check('#export-dest-recents');
  await page.fill('#export-name', 'The Quote');
  await page.click('#export-start');
  await expect(page.locator('#export-status')).toHaveText('Added to Recents as “The Quote”.', { timeout: 60000 });
  await expect(page.locator('#export-open-project')).toBeVisible();

  // in the library, not opened: the source is still the project on screen
  const list = await page.evaluate(() => window.HyperaudioSave.library.list());
  expect(list.filter((p) => p.name === 'The Quote')).toHaveLength(1);
  expect(list[0].name).toBe('The Quote');   // newest first in Recents
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(sourceId);
  const clip = list.find((p) => p.name === 'The Quote');
  expect(clip.media.kind).toBe('original');
  expect(clip.media.durationSeconds).toBeGreaterThan(9.1);   // 9.9–20.1 s less the struck second
  expect(clip.media.durationSeconds).toBeLessThan(9.3);

  // a reload lands back on the source, not on the project just added
  await page.reload();
  await expect(page.locator('#hypertranscript')).toContainText('w29');
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(sourceId);

  // opened, it is the clip: its words only, from 0:00, and its own media
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), clip.id);
  await expect(page.locator('#hypertranscript')).not.toContainText('w29');
  const words = await page.evaluate(() => [...document.querySelectorAll('#hypertranscript [data-m]')]
    .map((s) => [s.textContent.trim(), Number(s.getAttribute('data-m'))]));
  expect(words.map((w) => w[0])).toEqual(['w10', 'w11', 'w12', 'w13', 'w14', 'w16', 'w17', 'w18', 'w19']);
  expect(words[0][1]).toBe(100);
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 1 && p.duration > 9 && p.duration < 9.4;
  });
});

test('the Open it button opens the added project', async ({ page }, testInfo) => {
  await openFixture(page, testInfo);
  await select(page, 10, 12);
  await openExport(page);
  await page.selectOption('#export-format', 'wav');
  await page.check('#export-dest-recents');
  await page.fill('#export-name', 'Short');
  await page.click('#export-start');
  await expect(page.locator('#export-open-project')).toBeVisible({ timeout: 60000 });
  await page.click('#export-open-project');
  await expect(page.locator('#hypertranscript')).not.toContainText('w29');
  await expect(page.locator('#hypertranscript')).toContainText('w11');
  const current = await page.evaluate(async () => {
    const id = window.HyperaudioSave.library.currentId();
    return (await window.HyperaudioSave.library.list()).find((p) => p.id === id).name;
  });
  expect(current).toBe('Short');
});

// A finished run leaves a finished dialog: Done, not a button that repeats
// the job on a second click; any change makes it an export button again.
test('after a run the button is Done and closes the dialog; any change brings the export back', async ({ page }, testInfo) => {
  await openFixture(page, testInfo);
  await openExport(page);
  await page.selectOption('#export-format', 'wav');

  // Download
  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-start');
  await downloadPromise;
  await expect(page.locator('#export-status')).toHaveText('Done — check your downloads.', { timeout: 60000 });
  await expect(page.locator('#export-start')).toHaveText('DONE');
  await page.check('#export-dest-recents');                 // a change: an action again
  await expect(page.locator('#export-start')).toHaveText('ADD TO RECENTS');

  // Add to Recents, then Done closes
  await page.fill('#export-name', 'Whole Copy');
  await page.click('#export-start');
  await expect(page.locator('#export-status')).toHaveText('Added to Recents as “Whole Copy”.', { timeout: 60000 });
  await expect(page.locator('#export-start')).toHaveText('DONE');
  await expect(page.locator('#export-open-project')).toBeVisible();
  await page.click('#export-start');
  expect(await page.evaluate(() => document.getElementById('export-modal').checked)).toBe(false);

  // reopened, it starts fresh
  await openExport(page);
  await expect(page.locator('#export-start')).toHaveText('EXPORT');
  await expect(page.locator('#export-open-project')).toBeHidden();
});

test('Add to Recents turns WAV into M4A, and Download turns it back; a format picked by hand stays', async ({ page }, testInfo) => {
  await openFixture(page, testInfo);
  await openExport(page);
  const offered = await page.evaluate(() => [...document.getElementById('export-format').options].map((o) => o.value));
  test.skip(!offered.includes('m4a'), 'this browser cannot encode AAC (M4A), so there is nothing to swap WAV for');
  await page.selectOption('#export-format', 'wav');
  await page.check('#export-dest-recents');
  expect(await page.inputValue('#export-format')).toBe('m4a');
  await page.check('#export-dest-download');
  expect(await page.inputValue('#export-format')).toBe('wav');
  // picked by hand while adding to Recents: left alone either way
  await page.check('#export-dest-recents');
  await page.selectOption('#export-format', 'wav');
  await page.check('#export-dest-download');
  await page.check('#export-dest-recents');
  expect(await page.inputValue('#export-format')).toBe('m4a');   // a fresh choice of destination, from WAV
  await page.selectOption('#export-format', 'ogg');
  await page.check('#export-dest-download');
  expect(await page.inputValue('#export-format')).toBe('ogg');
});

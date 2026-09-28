// #698 — opening a .hyperaudio file placed it at the top of Recents, as if
// just edited: its entry was stamped with the clock, and the container's own
// `modified` thrown away (its `created` was kept). Recents orders by last
// EDIT; which project a reload returns to is lastActiveAt's business.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { ladderWav } from './helpers.mjs';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js');
const JSZip = require('jszip');

const OLD = '2026-07-10T11:30:00.000Z';

async function fixture(title, modified) {
  const state = {
    generatorVersion: 'e2e', created: '2026-07-01T09:00:00Z', modified,
    media: { kind: 'original', path: 'media/tone.wav', url: null, filename: 'tone.wav', mimeType: 'audio/wav', durationSeconds: 2, sizeBytes: 0 },
    options: { gapRemoval: { enabled: false, thresholdMs: 500, bufferMs: 100 }, updateCaptionsFromTranscript: true, view: { showSpeakers: true, showTimecodes: false } },
    texts: { title, language: 'en', summary: '', topics: [] },
    hasOriginal: false,
    transcript: { words: [{ start: 0.2, end: 0.8, text: 'Hello' }, { start: 0.9, end: 1.5, text: 'there' }], paragraphs: [{ speaker: '', start: 0.2, end: 1.5 }] },
  };
  return save.zipProject({
    json: save.serializeProjectJson(save.buildProjectJson(state)),
    html: '<article><section><p><span data-m="200" data-d="600">Hello </span><span data-m="900" data-d="600">there </span></p></section></article>',
    media: { name: 'tone.wav', data: ladderWav(2) },
  }, JSZip, 'nodebuffer');
}

const openFile = async (page, testInfo, title, modified) => {
  const path = testInfo.outputPath(`${title}.hyperaudio`);
  fs.writeFileSync(path, await fixture(title, modified));
  await page.setInputFiles('#project-open-input', path);
  await expect.poll(async () => (await page.evaluate(() => window.HyperaudioSave.library.list()))
    .some((p) => p.name === title)).toBe(true);
};
const entry = (page, name) => page.evaluate(async (n) =>
  (await window.HyperaudioSave.library.list()).find((p) => p.name === n), name);
const order = (page) => page.evaluate(async () => (await window.HyperaudioSave.library.list()).map((p) => p.name));

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('an opened file is placed by when it was last edited, not when it was opened', async ({ page }, testInfo) => {
  await openFile(page, testInfo, 'Old Interview', OLD);
  expect((await entry(page, 'Old Interview')).modifiedAt).toBe(Date.parse(OLD));
  const names = await order(page);
  expect(names[names.length - 1]).toBe('Old Interview');     // below the intro, edited since
  // it is still the project on screen, and what a reload returns to
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect(page.locator('#hypertranscript')).toContainText('Hello there');
});

test('a date in the future is taken as now, not pinned to the top forever', async ({ page }, testInfo) => {
  const before = Date.now();
  await openFile(page, testInfo, 'Wrong Clock', '2099-01-01T00:00:00.000Z');
  const at = (await entry(page, 'Wrong Clock')).modifiedAt;
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(Date.now());
});

test('editing the opened file afterwards moves it to the top', async ({ page }, testInfo) => {
  await openFile(page, testInfo, 'Old Interview', OLD);
  await page.click('#hypertranscript span[data-m="900"]');
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expect.poll(async () => (await order(page))[0], { timeout: 15000 }).toBe('Old Interview');
});

test('with a long list, the opened file’s row is brought into view', async ({ page }, testInfo) => {
  // fill the library so an old file lands below the visible rows
  await page.evaluate(async () => {
    const id = window.HyperaudioSave.library.currentId();
    for (let i = 0; i < 18; i += 1) await window.HyperaudioSave.library.duplicate(id);
  });
  await openFile(page, testInfo, 'Old Interview', OLD);
  await expect.poll(() => page.evaluate(() => {
    const row = document.querySelector('#file-picker .file-item.active');
    if (row === null) return 'no active row';
    const r = row.getBoundingClientRect();
    let box = row.parentElement;
    while (box && getComputedStyle(box).overflowY !== 'auto' && getComputedStyle(box).overflowY !== 'scroll') box = box.parentElement;
    const c = (box || document.documentElement).getBoundingClientRect();
    return row.textContent.trim() + (r.top >= c.top - 1 && r.bottom <= c.bottom + 1 ? ' visible' : ' hidden');
  })).toBe('Old Interview visible');
});

// #689 — export a clip from a transcript selection: the selected words'
// stretch of media, with strikeouts inside it removed, and everything that
// ships with it (retimed transcript, captions) limited to the clip.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { ladderWav } from './helpers.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

// 30 one-second words, "w0 " … "w29 "; w15 struck out
const WORDS = Array.from({ length: 30 }, (_, i) =>
  `<span data-m="${i * 1000}" data-d="1000"${i === 15 ? ' style="text-decoration: line-through;"' : ''}>w${i} </span>`).join('');

const setup = async (page) => {
  const wav = ladderWav(30, 8000);
  await page.route('**/__clip.wav', (route) => route.fulfill({ body: wav, contentType: 'audio/wav' }));
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function');
  await page.evaluate(async () => {
    const blob = await (await fetch('/__clip.wav')).blob();
    document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 1 && p.duration > 29;
  });
  await page.evaluate((html) => {
    document.getElementById('hypertranscript').innerHTML = `<article><section><p>${html}</p></section></article>`;
    // a caption track to match: one cue per pair of words, "w10 w11" at 10–12 s
    const t = (s) => `00:00:${String(s).padStart(2, '0')}.000`;
    const cues = Array.from({ length: 15 }, (_, k) => `${t(2 * k)} --> ${t(2 * k + 2)}\nw${2 * k} w${2 * k + 1}\n`);
    document.getElementById('hyperplayer-vtt').src = 'data:text/vtt,' + encodeURIComponent('WEBVTT\n\n' + cues.join('\n'));
  }, WORDS);
};

// select from word `from` to word `to`, both inclusive, as a user would
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
    document.activeElement && document.activeElement.blur();
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
};

test('a transcript selection is offered as a clip, and chosen', async ({ page }) => {
  await setup(page);
  await select(page, 10, 19);
  await openExport(page);
  await expect(page.locator('#export-source-clip-row')).toBeVisible();
  expect(await page.evaluate(() => document.getElementById('export-source-clip').checked)).toBe(true);
  // w10 starts at 10 s, w19 ends at 20 s: padded, 9.9–20.1 s, less the
  // struck w15 (15–16 s), 9.2 s
  await expect(page.locator('#export-clip-summary')).toHaveText('(0:10–0:20, 0:09)');
  expect(await page.inputValue('#export-name')).toMatch(/-0m10s$/);
  // switching source swaps the default name back, and back again
  await page.check('#export-source-entire');
  expect(await page.inputValue('#export-name')).not.toMatch(/-0m10s$/);
  await page.check('#export-source-clip');
  expect(await page.inputValue('#export-name')).toMatch(/-0m10s$/);
});

test('a click back into the transcript forgets the selection', async ({ page }) => {
  await setup(page);
  await select(page, 10, 19);
  await page.evaluate(() => {
    const span = document.querySelectorAll('#hypertranscript [data-m]')[3];
    const range = document.createRange();
    range.setStart(span.firstChild, 1);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await openExport(page);
  await expect(page.locator('#export-source-clip-row')).toBeHidden();
  expect(await page.evaluate(() => document.getElementById('export-source-clip').checked)).toBe(false);
});

test('the clip exports only its stretch, struck words out, and its transcript carries only its words', async ({ page }) => {
  await setup(page);
  await select(page, 10, 19);
  await openExport(page);
  await page.selectOption('#export-format', 'wav');
  await page.evaluate(() => {
    const set = (id, on) => {
      const c = document.getElementById(id);
      if (c) { c.checked = on; c.dispatchEvent(new Event('change')); }
    };
    ['export-vtt', 'export-burn', 'export-project', 'export-adjust'].forEach((id) => set(id, false));
    set('export-retime', true);
    set('export-srt', true);
    set('export-zip', true);
    document.getElementById('export-name').value = 'clip';
  });
  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-start');
  const download = await downloadPromise;
  await page.waitForFunction(() => document.getElementById('export-status').textContent.startsWith('Done'));

  const fs = await import('node:fs/promises');
  const zip = await JSZip.loadAsync(await fs.readFile(await download.path()));
  const wav = Buffer.from(await zip.file('clip/clip.wav').async('uint8array'));
  // WAV: byte rate at 28, data chunk size after the 'data' tag
  const byteRate = wav.readUInt32LE(28);
  const dataAt = wav.indexOf('data');
  const seconds = wav.readUInt32LE(dataAt + 4) / byteRate;
  expect(seconds).toBeGreaterThan(9.1);   // 9.9–20.1 s, less the struck second
  expect(seconds).toBeLessThan(9.3);

  const pageName = Object.keys(zip.files).find((p) => p.endsWith('.html'));
  const html = await zip.file(pageName).async('string');
  const words = [...html.matchAll(/data-m="(\d+)"[^>]*>(w\d+)/g)].map((m) => [m[2], Number(m[1])]);
  expect(words.map((w) => w[0])).toEqual(['w10', 'w11', 'w12', 'w13', 'w14', 'w16', 'w17', 'w18', 'w19']);
  expect(words[0][1]).toBe(100);           // 10 s in the original, 0.1 s into the clip
  expect(words[5][1]).toBe(5100);          // w16: after the struck second is cut

  // the captions are the ones over the selected words: not "w8 w9" or
  // "w20 w21", which only reach into the padding. (A caption that survives
  // keeps all its words, so "w14 w15" keeps the struck w15, as in any export.)
  const srt = await zip.file('clip/clip.srt').async('string');
  const spoken = [...srt.matchAll(/\bw(\d+)\b/g)].map((m) => Number(m[1]));
  expect(spoken).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
});

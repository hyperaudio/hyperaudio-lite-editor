// #815 — the More languages tab: models made for one language each, run in
// the browser, Swecha Gonthuka for Telugu first. It is experimental, so it is
// in the dialog only while Settings ▸ Experimental features is on. The worker
// is replaced by a stand-in that answers with the converter fixture, Swecha
// Gonthuka's real frames for two Telugu clips, so the tab, the engine
// contract and the converter are under test, not the 190 MB model.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { ladderWav } from './helpers.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/converters/wav2vec2.json', import.meta.url), 'utf8'));

const tabShown = (page) => page.evaluate(() => document.querySelector('input[name="local_tabs"][aria-label="More languages"]') !== null);
const checkedLocalTab = (page) => page.evaluate(() => document.querySelector('input[name="local_tabs"]:checked')?.getAttribute('aria-label'));
const flip = (page) => page.evaluate(() => document.getElementById('setting-experimental').click());
const ready = async (page) => { await page.goto('/index.html'); await page.waitForSelector('#hypertranscript [data-m]'); };

// a stand-in for js/more-languages.worker.js that records the request and
// answers as the worker does, with the fixture's frames
const standInWorker = (page, output = { ...FIXTURE, seconds: 1 }) => page.addInitScript((output) => {
  window.__posted = [];
  const RealWorker = window.Worker;
  window.Worker = class extends RealWorker {
    constructor(url, opts) {
      const answer = String(url).includes('more-languages.worker')
        ? `self.onmessage = () => {
             self.postMessage({ type: 'progress', phase: 'transcribe', progress: 50 });
             self.postMessage({ type: 'device', device: 'wasm', dtype: 'fp16' });
             self.postMessage({ type: 'result', output: ${JSON.stringify(output)} });
           };`
        : 'self.onmessage = () => {};';
      super(URL.createObjectURL(new Blob([answer], { type: 'text/javascript' })), opts);
      this.__url = String(url);
    }
    postMessage(data, transfer) {
      if (this.__url.includes('more-languages.worker')) window.__posted.push({ model: data.model, samples: data.audio && data.audio.length });
      return super.postMessage(data, transfer);
    }
  };
}, output);
const names = async (page) => (await page.evaluate(() => window.HyperaudioSave.library.list())).map((p) => p.name).sort();

test('the tab is out of the dialog until Experimental features is on, and comes and goes with the switch', async ({ page }) => {
  await ready(page);
  expect(await tabShown(page)).toBe(false);
  // the form is in the page all the same, hidden, so the editor's lists of
  // engine inputs find it at load
  expect(await page.evaluate(() => document.getElementById('more-languages-file') !== null)).toBe(true);
  await page.evaluate(() => { document.getElementById('transcribe-modal').checked = true; });
  await expect(page.locator('#more-languages-panel')).toBeHidden();
  // the Settings switch is offered, as something in the page is experimental
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('setting-experimental-row')).display)).not.toBe('none');
  await flip(page);
  expect(await tabShown(page)).toBe(true);
  await flip(page);
  expect(await tabShown(page)).toBe(false);
  await flip(page);
  expect(await tabShown(page)).toBe(true);
  // the switch on and off twice, the form is built and filled once
  expect(await page.evaluate(() => [...document.querySelectorAll('#more-languages-model option')].map((o) => [o.value, o.textContent])))
    .toEqual([['swecha-gonthuka-te', 'Telugu – Swecha Gonthuka']]);
  expect(await page.evaluate(() => document.querySelectorAll('#more-languages-submit-btn').length)).toBe(1);
  await ready(page);
  expect(await tabShown(page)).toBe(true);   // the switch survives a reload
});

test('switching experimental features off while the tab is open opens the first local tab instead', async ({ page }) => {
  await ready(page);
  await flip(page);
  await page.evaluate(() => document.querySelector('input[name="local_tabs"][aria-label="More languages"]').click());
  expect(await checkedLocalTab(page)).toBe('More languages');
  await flip(page);
  expect(await checkedLocalTab(page)).toBe('Parakeet');
});

test('a Telugu transcription: the words, one paragraph without punctuation, the language and the details', async ({ page }, testInfo) => {
  await standInWorker(page);
  await ready(page);
  await flip(page);
  const wavPath = testInfo.outputPath('tone.wav');
  writeFileSync(wavPath, ladderWav(2));
  await page.setInputFiles('#more-languages-file', wavPath);
  await page.evaluate(() => {
    document.getElementById('transcribe-modal').checked = true;
    document.getElementById('more-languages-submit-btn').click();
  });
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)').length)).toBe(12);
  const posted = await page.evaluate(() => window.__posted[0]);
  expect(posted).toEqual({ model: 'swecha-gonthuka-te', samples: 2 * 16000 });
  const page1 = await page.evaluate(() => ({
    first: document.querySelector('#hypertranscript span[data-m]').textContent.trim(),
    firstAt: document.querySelector('#hypertranscript span[data-m]').dataset.m,
    paragraphs: document.querySelectorAll('#hypertranscript p').length,
    busy: document.getElementById('hypertranscript').getAttribute('aria-busy'),
  }));
  expect(page1.first).toBe('అది');
  expect(page1.firstAt).toBe('680');
  expect(page1.paragraphs).toBe(1);
  // the project records the language and what ran, never a key
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.getProjectLanguage())).toBe('te');
  const provenance = await page.evaluate(() => window.HyperaudioSave.getProvenance());
  expect(provenance.modelId).toBe('therajasekhar/swecha-gonthuka-asr-ONNX');
  expect(provenance.parameters).toEqual({ model: 'swecha-gonthuka-te', revision: '66a830174695d3a10369d21619f5dd8eb5158ed2', dtype: 'fp16' });
  expect(provenance.runtime).toBe('onnxruntime-web');
  expect(page1.busy).not.toBe('true');
  // the new project is named after the media, switched on mid-session as here
  await expect.poll(() => names(page)).toContain('tone.wav');
});

test('no words is reported as a failure, not kept as an empty transcript', async ({ page }, testInfo) => {
  await standInWorker(page, { ...FIXTURE, frames: FIXTURE.frames.map(() => FIXTURE.blank), seconds: 1 });
  await ready(page);
  await flip(page);
  const wavPath = testInfo.outputPath('tone.wav');
  writeFileSync(wavPath, ladderWav(2));
  await page.setInputFiles('#more-languages-file', wavPath);
  await page.evaluate(() => {
    document.getElementById('transcribe-modal').checked = true;
    document.getElementById('more-languages-submit-btn').click();
  });
  await expect(page.locator('#hypertranscript')).toContainText('No words were produced');
  expect(await page.evaluate(() => document.getElementById('hypertranscript').getAttribute('aria-busy'))).not.toBe('true');
});

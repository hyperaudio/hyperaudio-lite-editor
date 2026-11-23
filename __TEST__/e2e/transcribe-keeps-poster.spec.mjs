// #828 — when a local transcription finished, the engine client moved the
// playhead back to 0 even when it was already there. Browsers treat that as a
// seek, and after a seek a video shows its current frame instead of its
// poster, so a video whose first frame is black showed a black player until
// the page was reloaded. The playhead is moved only when it has left 0, as
// when the video was played during the transcription.
//
// Each engine's worker is replaced by a stand-in that answers, after a pause,
// with that engine's own output from the converter fixtures, so the client's
// real path from result to transcript is under test, not the model.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/converters/${name}`, import.meta.url), 'utf8'));
const VIDEO = new URL('../fixtures/video-640x360.mp4', import.meta.url).pathname;

const ENGINES = [
  { name: 'Parakeet', worker: 'parakeet.worker', file: '#parakeet-file-input', submit: 'parakeet-form-submit-btn', output: { ...fixture('parakeet.json'), seconds: 1 } },
  { name: 'Whisper', worker: 'whisper.worker', file: '#file-input', submit: 'form-submit-btn', output: { ...fixture('whisper-chunks.json'), seconds: 1 } },
  { name: 'More languages', worker: 'more-languages.worker', file: '#more-languages-file', submit: 'more-languages-submit-btn', output: { ...fixture('wav2vec2.json'), seconds: 1 }, experimental: true },
];

// a stand-in for the engine's worker: it waits, so the test can play the
// video meanwhile, then answers as the real worker does
const standIn = (page, engine) => page.addInitScript(([match, output]) => {
  const RealWorker = window.Worker;
  window.Worker = class extends RealWorker {
    constructor(url, opts) {
      const ours = String(url).includes(match);
      const body = ours
        ? `self.onmessage = () => {
             self.postMessage({ type: 'device', device: 'wasm', dtype: 'fp16' });
             setTimeout(() => self.postMessage({ type: 'result', output: ${JSON.stringify(output)} }), 1500);
           };`
        : 'self.onmessage = () => {};';
      super(URL.createObjectURL(new Blob([body], { type: 'text/javascript' })), opts);
    }
  };
}, [engine.worker, engine.output]);

async function transcribe(page, engine, { playMeanwhile }) {
  await standIn(page, engine);
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  if (engine.experimental) await page.evaluate(() => document.getElementById('setting-experimental').click());
  await page.setInputFiles(engine.file, VIDEO);
  // every seek on the player from here on
  await page.evaluate(() => {
    const player = document.getElementById('hyperplayer');
    window.__seeks = [];
    player.addEventListener('seeking', () => window.__seeks.push(player.currentTime));
  });
  await page.evaluate((submit) => {
    document.getElementById('transcribe-modal').checked = true;
    document.getElementById(submit).click();
  }, engine.submit);
  await expect.poll(() => page.evaluate(() => document.getElementById('hypertranscript').getAttribute('aria-busy'))).toBe('true');
  if (playMeanwhile) {
    await expect.poll(() => page.evaluate(() => document.getElementById('hyperplayer').readyState)).toBeGreaterThan(0);
    await page.evaluate(() => { document.getElementById('hyperplayer').currentTime = 1; });
    await expect.poll(() => page.evaluate(() => window.__seeks.length)).toBe(1);
  }
  await expect.poll(() => page.evaluate(() => document.getElementById('hypertranscript').getAttribute('aria-busy'))).not.toBe('true');
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)').length)).toBeGreaterThan(0);
  await page.waitForTimeout(300);
}

for (const engine of ENGINES) {
  test(`${engine.name}: a finished transcription leaves a playhead already at 0 alone, so the poster stays`, async ({ page }) => {
    await transcribe(page, engine, { playMeanwhile: false });
    expect(await page.evaluate(() => window.__seeks)).toEqual([]);
    expect(await page.evaluate(() => document.getElementById('hyperplayer').currentTime)).toBe(0);
  });

  test(`${engine.name}: a playhead moved during the transcription still goes back to 0`, async ({ page }) => {
    await transcribe(page, engine, { playMeanwhile: true });
    expect(await page.evaluate(() => window.__seeks)).toEqual([1, 0]);
    expect(await page.evaluate(() => document.getElementById('hyperplayer').currentTime)).toBe(0);
  });
}

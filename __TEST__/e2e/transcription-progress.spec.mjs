// #676 — local transcription's percentage used to move only when a whole
// five-minute window finished. The worker now reports facts within a window
// (which stage, which frame) and the page turns them into a percentage that
// moves several times a second. The model never runs here: the worker's
// reporting is checked against a stub runtime, and the page's rendering
// against a scripted worker.
import { test, expect } from '@playwright/test';
import { ladderWav } from './helpers.mjs';

// onnxruntime replaced by a stub whose sessions answer with the tensors the
// worker's loop reads: an encoder output of FRAMES frames, a decoder that
// always picks blank and advances one frame
const FRAMES = 200;
const ORT_STUB = `
export const env = { wasm: {}, webgpu: {} };
export class Tensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
  dispose() {}
}
const D = 1024, VOCAB = 8193, FRAMES = ${FRAMES};
export const InferenceSession = {
  create: async (bytes, opts) => ({
    run: async (feeds) => {
      if ('waveforms' in feeds) return { features: new Tensor('float32', new Float32Array(128 * 10), [1, 128, 10]), features_lens: new Tensor('int64', BigInt64Array.from([10n]), [1]) };
      if ('audio_signal' in feeds) {
        await new Promise((r) => setTimeout(r, 300));   // the encoder takes a moment
        return { outputs: new Tensor('float32', new Float32Array(D * FRAMES), [1, D, FRAMES]), encoded_lengths: new Tensor('int64', BigInt64Array.from([BigInt(FRAMES)]), [1]) };
      }
      const logits = new Float32Array(VOCAB + 5); logits[VOCAB - 1] = 1; logits[VOCAB + 1] = 1;   // blank, step 1
      return { outputs: new Tensor('float32', logits, [1, VOCAB + 5]), output_states_1: new Tensor('float32', new Float32Array(2 * 640), [2, 1, 640]), output_states_2: new Tensor('float32', new Float32Array(2 * 640), [2, 1, 640]) };
    },
    release: async () => {},
  }),
};
`;

test('the worker reports each window\'s stages and its frames as it decodes (#676)', async ({ page, context }) => {
  await context.route('**/ort.all.min.mjs', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: ORT_STUB }));
  await context.route('https://huggingface.co/**', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from('a b\n') }));
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const details = await page.evaluate(async () => {
    const worker = new Worker('js/parakeet.worker.js', { type: 'module' });
    const seen = [];
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no terminal message')), 30000);
      worker.addEventListener('message', (e) => {
        if (e.data.type === 'progress' && e.data.detail) seen.push(e.data.detail);
        if (e.data.type === 'result' || e.data.type === 'error') { clearTimeout(timer); resolve(e.data.type); }
      });
    });
    const audio = new Float32Array(16000 * 5);   // under MIN_SPEECH_S, so no words is not an error
    worker.postMessage({ type: 'INFERENCE_REQUEST', audio }, [audio.buffer]);
    await done;
    worker.terminate();
    return seen;
  });
  expect(details[0]).toMatchObject({ window: 0, windows: 1, stage: 'encode', seconds: 5 });
  const decodeStart = details.find((d) => d.stage === 'decode' && typeof d.encoderMs === 'number');
  expect(decodeStart).toMatchObject({ frames: FRAMES, frame: 0 });
  expect(decodeStart.encoderMs).toBeGreaterThanOrEqual(250);
  const frames = details.filter((d) => d.stage === 'decode' && typeof d.frame === 'number').map((d) => d.frame);
  expect(frames.length).toBeGreaterThanOrEqual(3);                       // 200 frames, a report every 50
  expect([...frames].sort((a, b) => a - b)).toEqual(frames);            // rising
  expect(details[details.length - 1]).toMatchObject({ stage: 'done', window: 0 });
  expect(typeof details[details.length - 1].decodeMs).toBe('number');
});

// The client's worker replaced by a script that plays a window's facts over
// a few seconds: the page must show a percentage that moves through them, a
// point at a time.
const SCRIPTED_WORKER = `
const post = (m) => self.postMessage(m);
self.addEventListener('message', async (e) => {
  if (e.data.type !== 'INFERENCE_REQUEST') return;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  post({ type: 'device', device: 'webgpu', dtype: 'fp16' });
  post({ type: 'progress', phase: 'transcribe', progress: null, detail: { window: 0, windows: 1, stage: 'encode', seconds: 60 } });
  await wait(1500);   // 60 s at the default 40x: 1.5 s expected, so the encoder's half is counted in full
  post({ type: 'progress', phase: 'transcribe', progress: null, detail: { window: 0, windows: 1, stage: 'decode', frames: 100, frame: 0, encoderMs: 1500 } });
  for (let f = 10; f <= 100; f += 10) { await wait(600); post({ type: 'progress', phase: 'transcribe', progress: null, detail: { window: 0, windows: 1, stage: 'decode', frame: f } }); }
  post({ type: 'progress', phase: 'transcribe', progress: null, detail: { window: 0, windows: 1, stage: 'done', decodeMs: 6000 } });
  post({ type: 'result', output: { words: [{ word: 'hello', start: 0.5, end: 0.9 }], seconds: 2 } });
});
`;

test('the page shows a percentage that moves within the window (#676)', async ({ page, context }, testInfo) => {
  await context.route('**/js/parakeet.worker.js*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: SCRIPTED_WORKER }));
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const readings = [];
  const sampler = setInterval(async () => {
    const t = await page.evaluate(() => (document.querySelector('#hypertranscript .transcribing-msg') || {}).textContent || '').catch(() => '');
    const m = /Transcribing… (\d+)%/.exec(t);
    if (m) readings.push(Number(m[1]));
  }, 60);
  const wavPath = testInfo.outputPath('tone.wav');
  (await import('node:fs')).writeFileSync(wavPath, ladderWav(3));
  await page.setInputFiles('#parakeet-file-input', wavPath);
  await page.evaluate(() => document.getElementById('parakeet-form-submit-btn').click());
  await expect(page.locator('#hypertranscript')).toContainText('hello', { timeout: 30000 });
  clearInterval(sampler);
  const distinct = [...new Set(readings)];
  // many distinct values, rising a point at a time (the sampler may skip one),
  // with something seen DURING the encoder and DURING the decode
  expect(distinct.length).toBeGreaterThanOrEqual(20);
  expect([...distinct].sort((a, b) => a - b)).toEqual(distinct);
  // (a point at a time until the finish, which counts the rest faster than the sampler)
  for (let i = 1; i < distinct.length && distinct[i] < 60; i++) expect(distinct[i] - distinct[i - 1]).toBeLessThanOrEqual(2);
  expect(distinct.some((p) => p > 0 && p < 50)).toBe(true);
  expect(distinct.some((p) => p > 50 && p < 100)).toBe(true);
  expect(distinct[distinct.length - 1]).toBe(100);   // 100 is shown before the transcript replaces the loader
});

// Whisper's window is one opaque call, so the worker can only say when a
// window starts and ends; the page paces the percentage between the two by
// elapsed time. The scripted worker answers two requests without a second
// "device" message, as the real one does once its model is loaded: the
// second run must start from zero again rather than inherit the first's 100%.
const SCRIPTED_WHISPER = `
const post = (m) => self.postMessage(m);
let runs = 0;
self.addEventListener('message', async (e) => {
  if (e.data.type !== 'INFERENCE_REQUEST') return;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (runs++ === 0) post({ type: 'device', device: 'webgpu', dtype: 'fp16' });
  post({ type: 'progress', phase: 'transcribe', progress: null, detail: { window: 0, windows: 1, stage: 'run', seconds: 16 } });
  await wait(3000);
  post({ type: 'progress', phase: 'transcribe', progress: null, detail: { window: 0, windows: 1, stage: 'done', runMs: 3000 } });
  post({ type: 'result', output: { chunks: [{ text: ' hello', timestamp: [0.5, 0.9] }], seconds: 2 } });
});
`;

test('Whisper\'s percentage moves between a window\'s start and end, and a second run starts over (#676)', async ({ page, context }, testInfo) => {
  await context.route('**/js/whisper.worker.js*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: SCRIPTED_WHISPER }));
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const wavPath = testInfo.outputPath('tone.wav');
  (await import('node:fs')).writeFileSync(wavPath, ladderWav(3));

  const run = async () => {
    const readings = [];
    const sampler = setInterval(async () => {
      const t = await page.evaluate(() => (document.querySelector('#hypertranscript .transcribing-msg') || {}).textContent || '').catch(() => '');
      const m = /Transcribing… (\d+)%/.exec(t);
      if (m) readings.push(Number(m[1]));
    }, 60);
    await page.setInputFiles('#file-input', wavPath);
    await page.evaluate(() => document.getElementById('form-submit-btn').click());
    await expect(page.locator('#hypertranscript')).toContainText('hello', { timeout: 30000 });
    clearInterval(sampler);
    return [...new Set(readings)];
  };

  const first = await run();
  expect(first.length).toBeGreaterThanOrEqual(10);
  expect([...first].sort((a, b) => a - b)).toEqual(first);
  expect(first[0]).toBeLessThan(20);                                // 16 s of audio at the default 4x: 4 s expected, so the bar climbs through the 3 s
  for (let i = 1; i < first.length && first[i] < 25; i++) expect(first[i] - first[i - 1]).toBeLessThanOrEqual(2);
  expect(first.some((p) => p > 20 && p < 100)).toBe(true);
  expect(first[first.length - 1]).toBe(100);   // 100 is shown before the transcript replaces the loader

  // the second run is paced by the first's measured 3 s, and starts low
  // rather than at the first run's 100
  const second = await run();
  expect(second[0]).toBeLessThan(20);
  expect(second.some((p) => p > 20 && p < 100)).toBe(true);
  expect([...second].sort((a, b) => a - b)).toEqual(second);
});

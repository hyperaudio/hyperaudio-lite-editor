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
// two seconds: the page must show a percentage that moves through them.
const SCRIPTED_WORKER = `
const post = (m) => self.postMessage(m);
self.addEventListener('message', async (e) => {
  if (e.data.type !== 'INFERENCE_REQUEST') return;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  post({ type: 'device', device: 'webgpu', dtype: 'fp16' });
  post({ type: 'progress', phase: 'transcribe', progress: null, detail: { window: 0, windows: 1, stage: 'encode', seconds: 300 } });
  await wait(900);
  post({ type: 'progress', phase: 'transcribe', progress: null, detail: { window: 0, windows: 1, stage: 'decode', frames: 100, frame: 0, encoderMs: 900 } });
  for (let f = 10; f <= 100; f += 10) { await wait(100); post({ type: 'progress', phase: 'transcribe', progress: null, detail: { window: 0, windows: 1, stage: 'decode', frame: f } }); }
  post({ type: 'progress', phase: 'transcribe', progress: null, detail: { window: 0, windows: 1, stage: 'done', decodeMs: 1000 } });
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
  // several distinct values, rising, with something seen DURING the encoder and DURING the decode
  expect(distinct.length).toBeGreaterThanOrEqual(5);
  expect([...distinct].sort((a, b) => a - b)).toEqual(distinct);
  expect(distinct.some((p) => p > 0 && p < 50)).toBe(true);
  expect(distinct.some((p) => p > 50 && p < 100)).toBe(true);
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
  post({ type: 'progress', phase: 'transcribe', progress: null, detail: { window: 0, windows: 1, stage: 'run', seconds: 8 } });
  await wait(1500);
  post({ type: 'progress', phase: 'transcribe', progress: null, detail: { window: 0, windows: 1, stage: 'done', runMs: 1500 } });
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
  expect(first.length).toBeGreaterThanOrEqual(4);
  expect([...first].sort((a, b) => a - b)).toEqual(first);
  expect(first[0]).toBeLessThan(20);                                // 8 s of audio at the default 4x: 2 s expected, so the bar climbs through the 1.5 s
  expect(first.some((p) => p > 20 && p < 100)).toBe(true);

  // the second run is paced by the first's measured 1.5 s, so it climbs
  // most of the way — and starts low, not at the first run's 100
  const second = await run();
  expect(second[0]).toBeLessThan(30);
  expect(second.some((p) => p >= 50 && p < 100)).toBe(true);
  expect([...second].sort((a, b) => a - b)).toEqual(second);
});

import { test, expect } from '@playwright/test';
import { ladderWav } from './helpers.mjs';

// #529 — the worker's error protocol: only the request's own try/catch may
// declare a request dead ({type:"error"}). In the field, ort's jsep runtime
// threw a TypeError OUTSIDE that scope while the planned GPU→int8 fallback
// carried on — the uncaught error reached the page as worker.onerror, painted
// the fatal "reload the page" screen and killed the in-progress Recents row,
// and the transcription then SUCCEEDED behind the error screen. The worker
// now suppresses its own uncaught errors/rejections (logging them); the
// page-side onerror stays fatal because with suppression in place it can only
// mean the worker script itself failed to load or parse.
//
// Same stubbing technique as parakeet-cache.spec.mjs: the onnxruntime CDN is
// replaced by a stub, HuggingFace serves tiny bytes. The stub's create()
// first schedules an uncaught async TypeError — the field crash's shape —
// and then throws synchronously, so the request errors through the correct
// channel while the async landmine goes off outside it.

const ORT_STUB = `
export const env = { wasm: {} };
export const InferenceSession = {
  create: async () => {
    queueMicrotask(() => { throw new TypeError("simulated jsep crash outside the request scope"); });
    await new Promise((r) => setTimeout(r, 20)); // let the microtask detonate first
    throw new Error('stub refuses every model');
  },
};
`;

test('an uncaught worker error is suppressed; the request errors through its own channel (#529)', async ({ page, context }) => {
  await context.route('**/ort.all.min.mjs', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: ORT_STUB,
  }));
  await context.route('https://huggingface.co/**', (route) => route.fulfill({
    status: 200, contentType: 'application/octet-stream', body: Buffer.alloc(12, 7),
  }));
  const consoles = [];
  page.on('console', (m) => consoles.push(m.text()));

  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const result = await page.evaluate(async () => {
    const worker = new Worker('js/parakeet.worker.js', { type: 'module' });
    const onerrorEvents = [];
    worker.addEventListener('error', (e) => onerrorEvents.push(e.message || 'crash'));
    const errorMessage = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no terminal message')), 30000);
      worker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'error') { clearTimeout(timer); resolve(e.data.message); }
      });
      const audio = new Float32Array(16000);
      worker.postMessage({ type: 'INFERENCE_REQUEST', audio }, [audio.buffer]);
    });
    // the async landmine has already fired (create awaited past it); a beat
    // for any straggler error event to reach this thread
    await new Promise((r) => setTimeout(r, 300));
    worker.terminate();
    return { errorMessage, onerrorEvents };
  });

  // the request died through the protocol — with the real reason...
  expect(result.errorMessage).toContain('stub refuses');
  // ...and the uncaught TypeError never became a page-visible crash, so the
  // fatal screen and the Recents row teardown cannot be triggered by it
  expect(result.onerrorEvents).toEqual([]);
  // the suppression is loud in the console, not silent
  expect(consoles.find((t) => t.includes('uncaught worker error (suppressed'))).toBeTruthy();
});

// #550 — the worker is created on demand and retired when idle. Wasm memory
// never shrinks once grown, so a live worker retains the ort heap forever —
// Safari's memory watchdog was reloading tabs left overnight. The tier is
// overridable so the test can wait it out.
test('the transcription worker is lazy, retired after idle, and recreated on demand (#550)', async ({ page, context }, testInfo) => {
  await context.route('**/ort.all.min.mjs', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript',
    body: 'export const env = { wasm: {} };\nexport const InferenceSession = { create: async () => { throw new Error("stub refuses"); } };',
  }));
  await context.route('https://huggingface.co/**', (route) => route.fulfill({
    status: 200, contentType: 'application/octet-stream', body: Buffer.alloc(12, 7),
  }));
  await page.addInitScript(() => { window.PARAKEET_WORKER_IDLE_MS = 800; });
  const consoles = [];
  page.on('console', (m) => consoles.push(m.text()));

  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // other engines (Whisper) still create their workers eagerly — count ours
  const parakeetWorkers = () => page.workers().filter((w) => w.url().includes('parakeet.worker')).length;
  expect(parakeetWorkers()).toBe(0); // lazy: no worker until a transcription asks

  const wavPath = testInfo.outputPath('tone.wav');
  (await import('node:fs')).writeFileSync(wavPath, ladderWav(2));
  await page.setInputFiles('#parakeet-file-input', wavPath);
  await page.evaluate(() => document.getElementById('parakeet-form-submit-btn').click());
  await expect(page.locator('#hypertranscript')).toContainText('Transcription failed', { timeout: 30000 });
  expect(parakeetWorkers()).toBe(1); // alive while the tier runs

  await expect.poll(parakeetWorkers, { timeout: 5000 }).toBe(0); // retired
  expect(consoles.find((t) => t.includes('idle worker retired'))).toBeTruthy();

  // a new request stands a fresh worker up
  await page.evaluate(() => document.getElementById('parakeet-form-submit-btn').click());
  await expect.poll(parakeetWorkers, { timeout: 10000 }).toBe(1);
});

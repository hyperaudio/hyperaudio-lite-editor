import { test, expect } from '@playwright/test';

// #477 — a poisoned model cache must heal itself. Field report: a corrupt
// cached Parakeet model (truncated first download, or artifacts of earlier
// code versions) failed session creation on EVERY run, and the only cure was
// the user clearing browser storage by hand. Two defences now exist in
// js/parakeet.worker.js:
//   1. validate on read — the cached byte count is checked against the
//      length sidecar recorded at download time; a mismatch evicts and
//      re-downloads instead of serving the bad bytes;
//   2. self-heal on create — when session creation throws on bytes that came
//      from the cache, the entry is evicted and fetched fresh for one retry.
//
// The real models are ~GB downloads, so the network is stubbed at the
// Playwright routing layer: the onnxruntime CDN module is replaced with a
// stub whose InferenceSession.create always throws (we test the cache
// machinery, not ONNX), and the HuggingFace model URLs serve a small
// distinctive byte pattern so "refetched from network" is observable in the
// cache afterwards.

const CACHE = 'parakeet-models-v1';
const MEL = 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/nemo128.onnx';
const LEN = '.expected-length';
const SERVED = 0x0a; // every network-served byte — distinct from seeded 0x07
const SERVED_SIZE = 12;

const ORT_STUB = `
export const env = { wasm: {} };
export const InferenceSession = {
  create: async () => { throw new Error('stub refuses every model'); },
};
`;

async function stubNetwork(context) {
  await context.route('**/ort.all.min.mjs', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: ORT_STUB,
  }));
  await context.route('https://huggingface.co/**', (route) => route.fulfill({
    status: 200, contentType: 'application/octet-stream',
    body: Buffer.alloc(SERVED_SIZE, SERVED),
  }));
}

// Seed the cache as a previous (interrupted or buggy) session might have
// left it, run the worker until its first error surfaces, and report the
// cache's state plus the worker's console lines.
async function runWorkerAgainstSeededCache(page, seedBytes, seedSidecar) {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  return page.evaluate(async ({ CACHE, MEL, LEN, seedBytes, seedSidecar }) => {
    const cache = await caches.open(CACHE);
    await cache.put(MEL, new Response(new Uint8Array(seedBytes).fill(7),
      { headers: { 'content-length': String(seedBytes) } }));
    if (seedSidecar !== null) {
      await cache.put(MEL + LEN, new Response(String(seedSidecar)));
    }

    const logs = [];
    const worker = new Worker('js/parakeet.worker.js', { type: 'module' });
    const errorMessage = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker never errored; logs: ' + logs.join(' | '))), 30000);
      worker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'error') { clearTimeout(timer); resolve(e.data.message); }
      });
      worker.addEventListener('error', (e) => { clearTimeout(timer); resolve(e.message); });
      const audio = new Float32Array(16000);
      worker.postMessage({ type: 'INFERENCE_REQUEST', audio }, [audio.buffer]);
    });
    worker.terminate();

    const stored = await cache.match(MEL);
    const buf = stored ? new Uint8Array(await stored.arrayBuffer()) : null;
    const sidecar = await cache.match(MEL + LEN);
    return {
      errorMessage,
      storedSize: buf ? buf.length : null,
      storedByte: buf && buf.length ? buf[0] : null,
      sidecarText: sidecar ? await sidecar.text() : null,
    };
  }, { CACHE, MEL, LEN, seedBytes, seedSidecar });
}

test('a truncated cached model is evicted on read and re-downloaded (#477)', async ({ page, context }) => {
  await stubNetwork(context);
  const consoles = [];
  page.on('console', (m) => consoles.push(m.text()));

  // 5 bytes on disk, 999 promised: the interrupted-download shape
  const result = await runWorkerAgainstSeededCache(page, 5, 999);

  // the bad entry was replaced by the network's bytes, sidecar updated
  expect(result.storedSize).toBe(SERVED_SIZE);
  expect(result.storedByte).toBe(SERVED);
  expect(result.sidecarText).toBe(String(SERVED_SIZE));
  // the stub refuses even fresh bytes, so the run still errs — but on the
  // MODEL, not on a silently-served corrupt cache
  expect(result.errorMessage).toContain('stub refuses');
  const evictionLine = consoles.find((t) => t.includes('corrupt cached') && t.includes('evicted'));
  expect(evictionLine).toBeTruthy();
});

test('session-create failure on cached bytes evicts and retries from the network (#477)', async ({ page, context }) => {
  await stubNetwork(context);
  const consoles = [];
  page.on('console', (m) => consoles.push(m.text()));

  // plausible cache: sizes agree, so read-time validation passes — only the
  // create-failure path can catch this one
  const result = await runWorkerAgainstSeededCache(page, SERVED_SIZE, SERVED_SIZE);

  // the seeded 0x07 bytes are gone; the cache now holds the network's 0x0a —
  // proof the heal path evicted and refetched rather than giving up
  expect(result.storedByte).toBe(SERVED);
  expect(result.errorMessage).toContain('stub refuses');
  const healLine = consoles.find((t) => t.includes('session creation failed on cached') && t.includes('retrying from network'));
  expect(healLine).toBeTruthy();
});

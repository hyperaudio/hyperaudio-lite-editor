import { test, expect } from '@playwright/test';
import { ladderWav } from './helpers.mjs';

// #785 — the local Parakeet engine offers two models side by side: NVIDIA's
// Parakeet TDT 0.6B v3 and Moondream's further-trained Ultra. The tab has a
// Model select that is remembered, the request to the worker carries the
// chosen id, the worker fetches that model's files (and v3's when no id is
// given, as every request did before), and Settings ▸ Downloaded models
// lists and removes each model on its own.

const V3 = 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/';
const ULTRA = 'https://huggingface.co/Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx/resolve/main/';

const ORT_STUB = 'export const env = { wasm: {} };\nexport const InferenceSession = { create: async () => { throw new Error("stub refuses"); } };';

// the network, stubbed: the runtime refuses every model (the cache and
// request machinery is under test, not ONNX), and every Hugging Face URL
// answers with a few bytes while its URL is recorded
async function stubNetwork(context, fetched) {
  await context.route('**/ort.all.min.mjs', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: ORT_STUB }));
  await context.route('https://huggingface.co/**', (route) => {
    fetched.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.alloc(12, 7) });
  });
}

// one request to a fresh worker, resolved with the worker's error message
const askWorker = (page, request) => page.evaluate(async (req) => {
  const worker = new Worker('js/parakeet.worker.js', { type: 'module' });
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker never answered')), 30000);
    worker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'error') { clearTimeout(timer); resolve(e.data.message); }
    });
    worker.addEventListener('error', (e) => { clearTimeout(timer); resolve(e.message); });
    const audio = new Float32Array(16000);
    worker.postMessage(Object.assign({ type: 'INFERENCE_REQUEST', audio }, req), [audio.buffer]);
  });
  worker.terminate();
  return message;
}, request);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('the Parakeet (Local) tab offers v3 and Ultra, v3 first, and remembers the choice', async ({ page }) => {
  const options = () => page.evaluate(() => Array.from(document.querySelectorAll('#parakeet-model option')).map((o) => [o.value, o.textContent]));
  expect(await options()).toEqual([
    ['parakeet-tdt-0.6b-v3', 'Parakeet TDT 0.6B v3'],
    ['parakeet-tdt-0.6b-v3-ultra', 'Parakeet TDT 0.6B Ultra'],
  ]);
  expect(await page.evaluate(() => document.getElementById('parakeet-model').value)).toBe('parakeet-tdt-0.6b-v3');
  // the template names no model: the text is about the engine
  expect(await page.evaluate(() => document.querySelector('client-parakeet-service .form-text').textContent)).toContain('Parakeet runs entirely in your browser');

  await page.evaluate(() => {
    const select = document.getElementById('parakeet-model');
    select.value = 'parakeet-tdt-0.6b-v3-ultra';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(() => document.getElementById('parakeet-model').value)).toBe('parakeet-tdt-0.6b-v3-ultra');
});

test('the request to the worker carries the chosen model', async ({ page, context }, testInfo) => {
  // a stand-in worker that records what the client posts and answers nothing
  await page.addInitScript(() => {
    window.__posted = [];
    const RealWorker = window.Worker;
    window.Worker = class extends RealWorker {
      constructor(url, opts) {
        super(URL.createObjectURL(new Blob(['self.onmessage = () => {};'], { type: 'text/javascript' })), opts);
        this.__url = String(url);
      }
      postMessage(data, transfer) {
        if (this.__url.includes('parakeet.worker')) {
          window.__posted.push({ model: data.model, forceGpu: data.forceGpu, blankResetSeconds: data.blankResetSeconds, samples: data.audio && data.audio.length });
        }
        return super.postMessage(data, transfer);
      }
    };
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  const wavPath = testInfo.outputPath('tone.wav');
  (await import('node:fs')).writeFileSync(wavPath, ladderWav(2));
  await page.setInputFiles('#parakeet-file-input', wavPath);
  await page.evaluate(() => {
    const select = document.getElementById('parakeet-model');
    select.value = 'parakeet-tdt-0.6b-v3-ultra';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('parakeet-form-submit-btn').click();
  });
  await expect.poll(() => page.evaluate(() => window.__posted.length)).toBe(1);
  const posted = await page.evaluate(() => window.__posted[0]);
  expect(posted.model).toBe('parakeet-tdt-0.6b-v3-ultra');
  expect(posted.forceGpu).toBe(false);
  expect(posted.samples).toBe(2 * 16000);

  // and with v3 chosen, the id every request carried before #785
  await page.setInputFiles('#parakeet-file-input', wavPath);
  await page.evaluate(() => {
    const select = document.getElementById('parakeet-model');
    select.value = 'parakeet-tdt-0.6b-v3';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('parakeet-form-submit-btn').click();
  });
  await expect.poll(() => page.evaluate(() => window.__posted.length)).toBe(2);
  expect(await page.evaluate(() => window.__posted[1].model)).toBe('parakeet-tdt-0.6b-v3');
});

test('the worker fetches the files of the model it is asked for, v3 when none is named, and refuses an unknown id', async ({ page, context }) => {
  const fetched = [];
  await stubNetwork(context, fetched);

  expect(await askWorker(page, { model: 'parakeet-tdt-0.6b-v3-ultra' })).toContain('stub refuses');
  expect(fetched.length).toBeGreaterThan(0);
  expect(fetched.every((u) => u.startsWith(ULTRA))).toBe(true);
  expect(fetched.some((u) => u === ULTRA + 'nemo128.onnx')).toBe(true);
  expect(fetched.some((u) => u === ULTRA + 'int8/decoder_joint-model.int8.onnx')).toBe(true);

  fetched.length = 0;
  await page.evaluate(() => caches.delete('parakeet-models-v1'));
  expect(await askWorker(page, {})).toContain('stub refuses');
  expect(fetched.length).toBeGreaterThan(0);
  expect(fetched.every((u) => u.startsWith(V3))).toBe(true);

  fetched.length = 0;
  expect(await askWorker(page, { model: 'parakeet-tdt-9b' })).toContain('Unknown Parakeet model "parakeet-tdt-9b"');
  expect(fetched).toEqual([]);
});

test('Settings lists v3 and Ultra on their own and removes one without the other', async ({ page }) => {
  await page.evaluate(async ({ V3, ULTRA }) => {
    const cache = await caches.open('parakeet-models-v1');
    const put = (url, bytes) => cache.put(new Request(url), new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes) } }));
    await put(V3 + 'encoder-model.int8.onnx', 3e6);
    await put(V3 + 'encoder-model.int8.onnx.expected-length', 8);
    await put(ULTRA + 'int8/encoder-model.int8.onnx', 2e6);
    await put(ULTRA + 'nemo128.onnx', 1e5);
    await put(ULTRA + 'nemo128.onnx.expected-length', 6);
  }, { V3, ULTRA });
  await page.evaluate(() => {
    const m = document.getElementById('settings-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
    document.getElementById('settings-tab-application').checked = true;
  });
  await page.evaluate(() => window.HyperaudioSettings.refresh());
  const lines = () => page.evaluate(() => [...document.querySelectorAll('#settings-models li')].map((li) => li.textContent.trim().replace(/\s+/g, ' ')));
  await expect.poll(lines).toEqual([
    'Parakeet TDT 0.6B Ultra · multilingual2 MBRemove',
    'Parakeet TDT 0.6B v3 · multilingual3 MBRemove',
  ]);

  await page.evaluate(() => document.querySelector('button[aria-label="Remove Parakeet TDT 0.6B Ultra · multilingual"]').click());
  await expect.poll(lines).toEqual(['Parakeet TDT 0.6B v3 · multilingual3 MBRemove']);
  expect(await page.evaluate(async () => (await (await caches.open('parakeet-models-v1')).keys()).map((r) => r.url).sort())).toEqual([
    V3 + 'encoder-model.int8.onnx',
    V3 + 'encoder-model.int8.onnx.expected-length',
  ]);

  await page.evaluate(() => document.querySelector('button[aria-label="Remove Parakeet TDT 0.6B v3 · multilingual"]').click());
  await expect.poll(lines).toEqual([]);
  expect(await page.evaluate(() => caches.has('parakeet-models-v1'))).toBe(false);
});

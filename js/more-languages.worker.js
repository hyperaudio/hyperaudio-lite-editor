/**
 * more-languages.worker.js
 * (C) The Hyperaudio Project
 * @version 1.3.52 — last changed in release 1.3.52
 * @license AGPL-3.0-only
 *
 * The More languages engine (#815): speech-to-text models made for one
 * language each, run in the browser with onnxruntime-web. The first is Swecha
 * Gonthuka for Telugu, a wav2vec2 model with a CTC head.
 *
 * The client (js/hyperaudio-lite-editor-more-languages.js) sends
 *   { type: "INFERENCE_REQUEST", audio: Float32Array (16 kHz mono), model: id, preferGpu }
 * and this answers with progress, then
 *   { type: "result", output: { frames, vocab, frameSeconds, blank, separator, language, seconds } }
 * which js/converters/wav2vec2.js turns into words. Only the heavy part runs
 * here: the model, and the best token for each 20 ms frame.
 *
 * The audio goes through in 30 s windows with 3 s of context either side,
 * each normalised on its own as the model's feature extractor does. A window's
 * frames are kept only for its own 30 s, so nothing is lost or doubled where
 * two meet (checked on ten minutes of Telugu, #815).
 *
 * The GPU (WebGPU) when there is one that can do fp16, the CPU otherwise or
 * when the client asks for it (Firefox, whose WebGPU is slower than its CPU
 * path). On an M-series Mac in Chrome, ten minutes of audio took 6 s on the
 * GPU and over six minutes on the CPU, with the same error rates (#815). A
 * GPU that fails to start, or answers with nothing but blanks (a broken GPU
 * can "complete" with garbage, #460), hands over to the CPU. The session is
 * created with graph optimisation at "basic": at the default ("all")
 * onnxruntime 1.26 fails to create it on the CPU for this export.
 */
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.all.min.mjs";
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/";

const HF = "https://huggingface.co";
// Each model by the id the client sends. The files are pinned to a commit so
// they cannot change under the engine. Swecha Gonthuka's browser files are a
// community conversion of swechatelangana/swecha-gonthuka-asr (AGPL-3.0); the
// int8 file there is broken (it drops whole sentences), so this is the fp16.
const MODELS = {
  "swecha-gonthuka-te": {
    language: "te",
    model: `${HF}/therajasekhar/swecha-gonthuka-asr-ONNX/resolve/66a830174695d3a10369d21619f5dd8eb5158ed2/onnx/model_fp16.onnx`,
    vocab: `${HF}/therajasekhar/swecha-gonthuka-asr-ONNX/resolve/66a830174695d3a10369d21619f5dd8eb5158ed2/vocab.json`,
  },
};

const SAMPLE_RATE = 16000;
const HOP = 320;                         // samples per output frame: 20 ms
const WINDOW = 30 * SAMPLE_RATE;
const CONTEXT = 3 * SAMPLE_RATE;
// Must match cacheName in the client's HyperaudioModelStores entry.
const CACHE_NAME = "more-languages-models-v1";
const LEN_SUFFIX = ".expected-length";   // the byte count the download delivered (as #477)
const MAX_DOWNLOAD_ATTEMPTS = 5;
const IDLE_RELEASE_MS = 2 * 60 * 1000;   // free the session after two idle minutes (as #463)

let loaded = null;   // { id, device, session, vocab, blank, separator }
let idleTimer = null;

// The worker's own uncaught errors are reported by the request's catch, not
// as a fatal worker error the client would read as the worker dying (as #529).
self.addEventListener("error", (e) => e.preventDefault());

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "INFERENCE_REQUEST") return;
  clearTimeout(idleTimer);
  const id = String(event.data.model || "");
  const preferGpu = event.data.preferGpu !== false;
  let stage = "load";
  try {
    if (!Object.prototype.hasOwnProperty.call(MODELS, id)) throw new Error(`Unknown model "${id}"`);
    const device = preferGpu && await hasGpu() ? "webgpu" : "wasm";
    if (loaded === null || loaded.id !== id || loaded.device !== device) {
      if (loaded !== null) await release(loaded);
      loaded = null;
      loaded = await loadOnBestDevice(id, device);
    }
    self.postMessage({ type: "device", device: loaded.device, dtype: "fp16" });
    stage = "transcribe";
    const started = Date.now();
    let frames = await bestFrames(loaded, event.data.audio);
    if (loaded.device === "webgpu" && frames.every((f) => f === loaded.blank) && event.data.audio.length >= SAMPLE_RATE) {
      // nothing at all from a GPU is more likely the GPU than silence: the CPU
      // answers that question, at the CPU's pace
      console.warn("More languages: the GPU produced only blanks — trying the CPU");
      self.postMessage({ type: "fallback", message: "Retrying on the CPU…" });
      await release(loaded);
      loaded = null;
      loaded = await load(id, "wasm");
      self.postMessage({ type: "device", device: "wasm", dtype: "fp16" });
      frames = await bestFrames(loaded, event.data.audio);
    }
    self.postMessage({
      type: "result",
      output: {
        frames, vocab: loaded.vocab, frameSeconds: HOP / SAMPLE_RATE,
        blank: loaded.blank, separator: loaded.separator,
        language: MODELS[id].language, seconds: (Date.now() - started) / 1000,
      },
    });
  } catch (e) {
    console.error(e);
    self.postMessage({ type: "error", stage, message: e?.message || String(e) });
  } finally {
    scheduleIdleRelease();
  }
});

// A usable GPU is one that gives an adapter (headless and GPU-less machines
// expose the API and no adapter) with "shader-f16", which the fp16 model
// needs (#459).
async function hasGpu() {
  try {
    if (!self.navigator?.gpu) return false;
    const adapter = await self.navigator.gpu.requestAdapter();
    return adapter !== null && adapter.features.has("shader-f16");
  } catch (_) {
    return false;
  }
}

// The GPU session, or the CPU's when the GPU one cannot be made.
async function loadOnBestDevice(id, device) {
  if (device !== "webgpu") return load(id, "wasm");
  try {
    return await load(id, "webgpu");
  } catch (e) {
    console.warn(`More languages: the GPU session could not be made (${e?.message || e}) — using the CPU`);
    self.postMessage({ type: "fallback", message: "Preparing model on the CPU…" });
    return load(id, "wasm");
  }
}

function scheduleIdleRelease() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (loaded === null) return;
    const releasing = loaded;
    loaded = null;
    await release(releasing);
    console.log("More languages: model session released after idle — next transcription reloads from cache");
  }, IDLE_RELEASE_MS);
}

async function release(m) {
  try { await m.session?.release?.(); } catch (_) {}
}

async function load(id, device) {
  const spec = MODELS[id];
  // the vocabulary is cached beside the model, so a cached model works offline
  const table = JSON.parse(new TextDecoder().decode(await fetchModel(spec.vocab, () => {})));
  const vocab = [];
  Object.entries(table).forEach(([token, index]) => { vocab[index] = token; });
  for (let i = 0; i < vocab.length; i += 1) if (vocab[i] === undefined) vocab[i] = "";
  const bytes = await fetchModel(spec.model, (done, total) => {
    self.postMessage({ type: "progress", phase: "download", progress: total ? Math.round((done / total) * 100) : null });
  });
  self.postMessage({ type: "progress", phase: "prepare" });
  const session = await ort.InferenceSession.create(bytes, { executionProviders: [device], graphOptimizationLevel: "basic" });
  return { id, device, session, vocab, blank: table["<pad>"], separator: table["|"] };
}

// The best token for every 20 ms frame of the recording.
async function bestFrames(m, audio) {
  const total = Math.ceil(audio.length / HOP);
  const best = new Array(total).fill(m.blank);
  const windows = Math.max(1, Math.ceil(audio.length / WINDOW));
  for (let w = 0; w < windows; w += 1) {
    const keepFrom = w * WINDOW;
    const from = Math.max(0, keepFrom - CONTEXT);
    const to = Math.min(audio.length, keepFrom + WINDOW + CONTEXT);
    if (to - from < 400) break;   // shorter than the model's first layer can read
    // each window is one opaque call: its start and end are what the page's
    // tracker (#676, js/transcription-progress.js) moves the percentage by,
    // as Whisper's are
    self.postMessage({ type: "progress", phase: "transcribe", progress: Math.round((w / windows) * 100),
      detail: { window: w, windows, stage: "run", seconds: (to - from) / SAMPLE_RATE } });
    const windowStart = Date.now();
    const input = normalised(audio.subarray(from, to));
    const { logits } = await m.session.run({ input_values: new ort.Tensor("float32", input, [1, input.length]) });
    const [, count, size] = logits.dims;
    const data = logits.data;
    const offset = Math.round(from / HOP);
    for (let f = 0; f < count; f += 1) {
      const frame = offset + f;
      const at = frame * HOP;
      if (at < keepFrom || at >= keepFrom + WINDOW || frame >= total) continue;
      let arg = 0;
      let max = -Infinity;
      for (let v = 0; v < size; v += 1) {
        const x = data[f * size + v];
        if (x > max) { max = x; arg = v; }
      }
      best[frame] = arg;
    }
    logits.dispose?.();
    self.postMessage({ type: "progress", phase: "transcribe", progress: Math.round(((w + 1) / windows) * 100),
      detail: { window: w, windows, stage: "done", runMs: Date.now() - windowStart } });
  }
  return best;
}

// zero mean and unit variance, as Wav2Vec2FeatureExtractor's do_normalize
function normalised(x) {
  let mean = 0;
  for (let i = 0; i < x.length; i += 1) mean += x[i];
  mean /= x.length;
  let variance = 0;
  for (let i = 0; i < x.length; i += 1) variance += (x[i] - mean) ** 2;
  variance /= x.length;
  const sd = Math.sqrt(variance + 1e-7);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 1) y[i] = (x[i] - mean) / sd;
  return y;
}

// The model, from Cache Storage when it is there and whole, otherwise
// downloaded into it with progress. A cached copy of the wrong length is
// dropped and fetched again (as #477).
async function fetchModel(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch (_) { cache = null; }
  if (cache !== null) {
    const hit = await cache.match(url);
    if (hit) {
      try {
        const buf = await hit.arrayBuffer();
        const sidecar = await cache.match(url + LEN_SUFFIX);
        const expected = (sidecar && Number(await sidecar.text())) || null;
        if (expected !== null && buf.byteLength !== expected) throw new Error(`${buf.byteLength} bytes where ${expected} were expected`);
        onProgress(1, 1);
        return new Uint8Array(buf);
      } catch (e) {
        console.warn(`More languages: cached model unreadable (${e?.message || e}) — downloading it again`);
        await cache.delete(url);
        await cache.delete(url + LEN_SUFFIX);
      }
    }
  }
  for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
    let resp;
    try { resp = await fetch(url, { cache: "no-store" }); } catch (_) { continue; }
    if (!resp.ok) {
      if (resp.status >= 500 || resp.status === 429) continue;
      throw new Error(`Download failed (${resp.status}) for ${url.split("/").pop()}`);
    }
    const total = Number(resp.headers.get("content-length")) || 0;
    const reader = resp.body.getReader();
    const chunks = [];
    let done = 0;
    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        chunks.push(value);
        done += value.byteLength;
        onProgress(done, total);
      }
    } catch (_) {
      continue;   // the connection dropped: fetch the whole file again
    }
    const bytes = new Uint8Array(done);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    if (cache !== null) {
      try {
        await cache.put(url, new Response(bytes, { headers: { "content-length": String(done) } }));
        await cache.put(url + LEN_SUFFIX, new Response(String(done)));
      } catch (_) { /* no room: it is used for this session only */ }
    }
    return bytes;
  }
  throw new Error("Model download interrupted — please check your connection.");
}

/**
 * parakeet.worker.js
 * (C) The Hyperaudio Project
 * @version 0.6.8 — last changed in release 0.6.8
 * @license MIT
 */

import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.all.min.mjs";
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/";
ort.env.wasm.numThreads = self.crossOriginIsolated ? (self.navigator?.hardwareConcurrency || 4) : 1;

const SAMPLE_RATE = 16000;
const WINDOW_S = 300;        // 5-minute windows to bound memory
const OVERLAP_S = 10;        // each seam transcribed by both windows
const D = 1024;              // encoder hidden dim
const VOCAB_SIZE = 8193;     // token logits; index 8192 is <blk>
const BLANK = 8192;
const STATE_DIM = 640;       // decoder predict-net state width
const MAX_SYMBOLS = 10;      // max tokens emitted on a single frame
const FRAME_SEC = 0.08;      // 8x subsampling * 10ms hop

const HF = "https://huggingface.co";
const MODELS = {
  mel: `${HF}/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/nemo128.onnx`,
  decoder: `${HF}/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/decoder_joint-model.int8.onnx`,
  vocab: `${HF}/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/vocab.txt`,
  encoderInt8: `${HF}/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.int8.onnx`,
  encoderFp16: `${HF}/ako101/parakeet-tdt-0.6b-v3-sherpa-onnx-fp16/resolve/main/encoder.fp16.onnx`,
};
const CACHE_NAME = "parakeet-models-v1";

let sessions = null;   // { mel, encoder, decoder, vocab, device }

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "INFERENCE_REQUEST") {
    return;
  }
  try {
    if (sessions === null) {
      sessions = await loadSessions();
    }
    const output = await transcribe(sessions, event.data.audio);
    self.postMessage({ type: "result", output });
  } catch (e) {
    console.error(e);
    const stage = sessions === null ? "load" : "transcribe";
    self.postMessage({ type: "error", stage, message: e?.message || String(e) });
  }
});

// navigator.gpu existing does not mean a usable GPU exists (headless and
// GPU-less machines expose the API but yield no adapter), so it must be
// ruled out before attempting a WebGPU session, not after failing.
async function hasGpuAdapter() {
  try {
    if (!self.navigator?.gpu) {
      return false;
    }
    return (await self.navigator.gpu.requestAdapter()) !== null;
  } catch (e) {
    return false;
  }
}

// Fetch a model with progress, caching it so the (large) download is one-time.
async function fetchModel(url, onProgress) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) {
    onProgress(url, 1, 1);
    return new Uint8Array(await hit.arrayBuffer());
  }
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Download failed (${resp.status}) for ${url.split("/").pop()}`);
  }
  const total = Number(resp.headers.get("content-length")) || 0;
  const reader = resp.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onProgress(url, loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  try {
    await cache.put(url, new Response(bytes, { headers: { "content-length": String(loaded) } }));
  } catch (e) {
    // QuotaExceededError etc. – use the in-memory bytes this session, re-download next time
    console.warn("Model cache write failed (will re-download next time):", e?.message || e);
  }
  return bytes;
}

// Aggregate download progress across the model files (encoder dominates).
function makeDownloadProgress() {
  const files = new Map();
  let last = -1;
  return (url, loaded, total) => {
    if (!total) return;
    files.set(url, { loaded, total });
    let l = 0, t = 0;
    files.forEach((f) => { l += f.loaded; t += f.total; });
    const percent = Math.floor((l / t) * 100);
    if (percent !== last) {
      last = percent;
      self.postMessage({ type: "progress", phase: "download", progress: percent });
    }
  };
}

async function loadSessions() {
  const onProgress = makeDownloadProgress();
  const useWebGpu = !/firefox/i.test(self.navigator?.userAgent || "") && (await hasGpuAdapter());

  // mel + decoder always run on WASM (decoder loop is sequential and cheap –
  // keeping it off the GPU avoids per-token round-trips).
  const [melBytes, decBytes, vocabBytes] = await Promise.all([
    fetchModel(MODELS.mel, onProgress),
    fetchModel(MODELS.decoder, onProgress),
    fetchModel(MODELS.vocab, onProgress),
  ]);
  const mel = await ort.InferenceSession.create(melBytes, { executionProviders: ["wasm"] });
  const decoder = await ort.InferenceSession.create(decBytes, { executionProviders: ["wasm"] });
  const vocab = new TextDecoder().decode(vocabBytes).split("\n").map((l) => l.slice(0, l.lastIndexOf(" ")));

  let encoder, device, dtype;
  if (useWebGpu) {
    try {
      const encBytes = await fetchModel(MODELS.encoderFp16, onProgress);
      self.postMessage({ type: "progress", phase: "prepare" });
      encoder = await ort.InferenceSession.create(encBytes, { executionProviders: ["webgpu"] });
      await warmUp(encoder);
      device = "webgpu"; dtype = "fp16";
    } catch (e) {
      console.warn("WebGPU encoder unavailable, falling back to WASM/int8:", e?.message || e);
      encoder = null;
    }
  }
  if (!encoder) {
    const encBytes = await fetchModel(MODELS.encoderInt8, onProgress);
    self.postMessage({ type: "progress", phase: "prepare" });
    encoder = await ort.InferenceSession.create(encBytes, { executionProviders: ["wasm"] });
    device = "wasm"; dtype = "int8";
  }

  console.log(`Parakeet ready on ${device} (${dtype})`);
  self.postMessage({ type: "device", device, dtype });
  return { mel, encoder, decoder, vocab, device };
}

// Push a short silent clip through the encoder so WebGPU shader compilation
// (and any inference-time failure) happens now, under "Preparing model…".
async function warmUp(encoder) {
  const len = 100;
  await encoder.run({
    audio_signal: new ort.Tensor("float32", new Float32Array(128 * len), [1, 128, len]),
    length: new ort.Tensor("int64", BigInt64Array.from([BigInt(len)]), [1]),
  });
}

async function transcribe(s, audio) {
  const startedAt = Date.now();
  const windowSamples = WINDOW_S * SAMPLE_RATE;
  const stepSamples = (WINDOW_S - OVERLAP_S) * SAMPLE_RATE;
  const windowCount = audio.length <= windowSamples
    ? 1
    : Math.ceil((audio.length - windowSamples) / stepSamples) + 1;

  let words = [];
  for (let i = 0; i < windowCount; i++) {
    self.postMessage({
      type: "progress",
      phase: "transcribe",
      progress: windowCount > 1 ? Math.round((i / windowCount) * 100) : null,
    });
    const offsetSamples = i * stepSamples;
    const offsetSeconds = offsetSamples / SAMPLE_RATE;
    const win = audio.subarray(offsetSamples, offsetSamples + windowSamples);
    const windowWords = await transcribeWindow(s, win, offsetSeconds);
    words = i === 0 ? windowWords : dedupeSeam(words, windowWords);
    self.postMessage({
      type: "progress",
      phase: "transcribe",
      progress: windowCount > 1 ? Math.round(((i + 1) / windowCount) * 100) : null,
    });
  }

  const seconds = (Date.now() - startedAt) / 1000;
  console.log(`Parakeet transcription took ${seconds.toFixed(1)}s for ${(audio.length / SAMPLE_RATE).toFixed(1)}s of audio (${s.device})`);
  return { words, seconds };
}

async function transcribeWindow(s, samples, offsetSeconds) {
  // 1. mel features
  const mel = await s.mel.run({
    waveforms: new ort.Tensor("float32", samples.slice(), [1, samples.length]),
    waveforms_lens: new ort.Tensor("int64", BigInt64Array.from([BigInt(samples.length)]), [1]),
  });
  // 2. encoder
  const encT0 = Date.now();
  const enc = await s.encoder.run({ audio_signal: mel.features, length: mel.features_lens });
  const encData = enc.outputs.data;            // [1, D, T']
  const Tp = enc.outputs.dims[2];
  const encLen = Number(enc.encoded_lengths.data[0]);
  const encMs = Date.now() - encT0;
  const decT0 = Date.now();
  const frame = (t) => { const f = new Float32Array(D); for (let d = 0; d < D; d++) f[d] = encData[d * Tp + t]; return f; };

  // 3. TDT greedy decode loop
  const mkState = () => new ort.Tensor("float32", new Float32Array(2 * STATE_DIM), [2, 1, STATE_DIM]);
  let s1 = mkState(), s2 = mkState();
  const tokens = [], stamps = [];
  let t = 0, emitted = 0, last = BLANK;
  while (t < encLen) {
    const r = await s.decoder.run({
      encoder_outputs: new ort.Tensor("float32", frame(t), [1, D, 1]),
      targets: new ort.Tensor("int32", Int32Array.from([last]), [1, 1]),
      target_length: new ort.Tensor("int32", Int32Array.from([1]), [1]),
      input_states_1: s1,
      input_states_2: s2,
    });
    const o = r.outputs.data;
    let tok = 0, bv = -Infinity;
    for (let i = 0; i < VOCAB_SIZE; i++) if (o[i] > bv) { bv = o[i]; tok = i; }
    let step = 0, dv = -Infinity;
    for (let i = VOCAB_SIZE; i < o.length; i++) if (o[i] > dv) { dv = o[i]; step = i - VOCAB_SIZE; }
    if (tok !== BLANK) { s1 = r.output_states_1; s2 = r.output_states_2; tokens.push(tok); stamps.push(t); last = tok; emitted++; }
    if (step > 0) { t += step; emitted = 0; }
    else if (tok === BLANK || emitted === MAX_SYMBOLS) { t += 1; emitted = 0; }
  }

  console.log(`  window: encoder ${encMs}ms, decode ${Date.now() - decT0}ms (${encLen} frames)`);

  // 4. tokens -> words (▁ marks a word start); times offset by window start
  const words = [];
  let cur = null;
  for (let i = 0; i < tokens.length; i++) {
    const piece = s.vocab[tokens[i]] ?? "";
    const sec = offsetSeconds + stamps[i] * FRAME_SEC;
    if (piece.startsWith("▁") || !cur) {
      if (cur) words.push(cur);
      cur = { word: piece.replace(/▁/g, ""), start: sec, end: sec + FRAME_SEC };
    } else {
      cur.word += piece;
      cur.end = sec + FRAME_SEC;
    }
  }
  if (cur) words.push(cur);
  return words;
}

// Merge two overlapping windows: drop a word from the new window if it repeats
// the previous kept word within 0.5s (the overlap is transcribed by both).
function dedupeSeam(prev, next) {
  if (next.length === 0) return prev;
  const merged = prev.slice();
  for (const w of next) {
    const tail = merged[merged.length - 1];
    if (tail && w.word === tail.word && Math.abs(w.start - tail.start) < 0.5) continue;
    merged.push(w);
  }
  return merged;
}

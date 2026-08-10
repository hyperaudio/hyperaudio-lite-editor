/**
 * parakeet.worker.js
 * (C) The Hyperaudio Project
 * @version 1.3.2 — last changed in release 1.3.2
 * @license MIT
 */

import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.all.min.mjs";
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/";
ort.env.wasm.numThreads = self.crossOriginIsolated ? (self.navigator?.hardwareConcurrency || 4) : 1;

// The request's try/catch (the INFERENCE_REQUEST handler) is the ONE
// authority on fatality: it posts {type:"error"} when a request truly dies.
// ort's async internals can throw OUTSIDE that scope — the #529 field case
// was a TypeError from the jsep runtime surfacing as an uncaught worker
// error WHILE the planned GPU→int8 fallback carried on to a successful
// transcript. Propagated to the page, that painted the fatal "reload"
// screen and killed the in-progress Recents row for a request that was
// recovering. Uncaught errors are therefore logged and suppressed here; a
// worker that fails to even PARSE never installs these listeners, so a
// genuinely broken worker still reaches the page's onerror.
self.addEventListener("error", (e) => {
  e.preventDefault();
  console.warn("Parakeet: uncaught worker error (suppressed — the active request reports its own outcome):", e?.message || e);
});
self.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  console.warn("Parakeet: unhandled rejection in worker (suppressed):", e?.reason?.message || e?.reason || e);
});

const SAMPLE_RATE = 16000;
const WINDOW_S = 300;        // 5-minute windows to bound memory
const OVERLAP_S = 10;        // each seam transcribed by both windows
const D = 1024;              // encoder hidden dim
const VOCAB_SIZE = 8193;     // token logits; index 8192 is <blk>
const BLANK = 8192;
const STATE_DIM = 640;       // decoder predict-net state width
const MAX_SYMBOLS = 10;      // max tokens emitted on a single frame
const FRAME_SEC = 0.08;      // 8x subsampling * 10ms hop
const MIN_SPEECH_S = 10;     // audio at least this long is assumed to contain speech

const HF = "https://huggingface.co";
const MODELS = {
  mel: `${HF}/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/nemo128.onnx`,
  decoder: `${HF}/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/decoder_joint-model.int8.onnx`,
  vocab: `${HF}/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/vocab.txt`,
  encoderInt8: `${HF}/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.int8.onnx`,
  encoderFp16: `${HF}/ako101/parakeet-tdt-0.6b-v3-sherpa-onnx-fp16/resolve/main/encoder.fp16.onnx`,
};
const CACHE_NAME = "parakeet-models-v1";
// Sidecar cache key carrying the byte count the download actually delivered
// (#477). Never fetched — it only exists as a Cache Storage key.
const LEN_SUFFIX = ".expected-length";

// Drop a model's cache entry (and its length sidecar). Returns whether an
// entry existed — the self-heal path uses that to tell "cached bytes were
// bad" from "there was nothing cached to blame".
async function evictCached(url) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const existed = await cache.delete(url);
    await cache.delete(url + LEN_SUFFIX);
    return existed;
  } catch (_) {
    return false;
  }
}

let sessions = null;        // { mel, encoder, decoder, vocab, device }
let sessionsForceGpu = null; // the forceGpu flag the current sessions were built with

// The sessions hold the (GPU) model memory — ~1.2 GB for the fp16 encoder —
// and keeping them alive makes a follow-up transcription skip model setup.
// But the common flow is transcribe once, then edit for a long time, and the
// model squats on that memory the whole while (#463). Middle ground: free the
// sessions after a couple of idle minutes. The model bytes stay in Cache
// Storage, so a later transcription repeats only session creation and shader
// warm-up, not the download.
const IDLE_RELEASE_MS = 2 * 60 * 1000;
let idleTimer = null;

function scheduleIdleRelease() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (sessions === null) {
      return;
    }
    // detach before the awaited release so a request landing mid-release
    // rebuilds fresh sessions instead of grabbing dying ones
    const releasing = sessions;
    sessions = null;
    await releaseSessions(releasing);
    console.log("Parakeet: model sessions released after idle — next transcription reloads from cache");
  }, IDLE_RELEASE_MS);
}

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "INFERENCE_REQUEST") {
    return;
  }
  clearTimeout(idleTimer);
  const forceGpu = event.data.forceGpu === true;
  try {
    // Rebuild if the GPU opt-in changed since the sessions were created, so the
    // user can toggle GPU/CPU without reloading the page.
    if (sessions === null || sessionsForceGpu !== forceGpu) {
      if (sessions !== null) await releaseSessions(sessions);
      sessions = null;
      sessions = await loadSessions(forceGpu);
      sessionsForceGpu = forceGpu;
    }
    const output = await transcribe(sessions, event.data.audio);
    // A broken GPU can "complete" with no output at all (async WebGPU
    // validation errors never reject run()) — report that as a failure
    // rather than rendering a blank transcript as if it were done (#460).
    if (output.words.length === 0 && event.data.audio.length >= MIN_SPEECH_S * SAMPLE_RATE) {
      throw new Error("No words were produced — if this media contains speech, transcription failed silently. Reload the page and try again.");
    }
    self.postMessage({ type: "result", output });
  } catch (e) {
    console.error(e);
    const stage = sessions === null ? "load" : "transcribe";
    self.postMessage({ type: "error", stage, message: e?.message || String(e) });
  } finally {
    scheduleIdleRelease();
  }
});

// Free the GPU/WASM buffers held by a session set before building a new one.
async function releaseSessions(s) {
  for (const k of ["mel", "encoder", "decoder"]) {
    try { await s[k]?.release?.(); } catch (_) {}
  }
}

// navigator.gpu existing does not mean a usable GPU exists (headless and
// GPU-less machines expose the API but yield no adapter), so it must be
// ruled out before attempting a WebGPU session, not after failing. The
// adapter must also expose "shader-f16": the WebGPU path runs the fp16
// encoder, and on an adapter without f16 support (seen on Linux with WebGPU
// force-enabled over Vulkan) its pipelines fail compilation — asynchronously,
// so run() still resolves and the encoder emits garbage (#459).
async function hasGpuAdapter() {
  try {
    if (!self.navigator?.gpu) {
      return false;
    }
    const adapter = await self.navigator.gpu.requestAdapter();
    return adapter !== null && adapter.features.has("shader-f16");
  } catch (e) {
    return false;
  }
}

// Fetch a model, caching it so the (large) download is one-time.
//
// Preferred path streams the bytes straight into Cache Storage so the whole
// model never sits in JS memory: the old "collect every chunk then copy into one
// Uint8Array" assembly peaked at ~2× the file size (~2.5 GB for the fp16
// encoder) and tripped Safari's per-tab memory limit even on a tiny audio file.
// The session still needs the bytes, but only once (read back from cache), not
// twice. We fall back to an in-memory download only if Cache Storage can't be
// written (quota / private mode). Trade-off vs the previous code: a mid-stream
// drop now retries the whole file rather than resuming from the dropped byte —
// keeping the memory low matters more here than saving a re-download.
const MAX_DOWNLOAD_ATTEMPTS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { bytes, fromCache } — provenance feeds the self-heal decision in
// createSessionWithHeal (#477): only bytes that came from cache implicate the
// cache when session creation fails.
async function fetchModel(url, onProgress) {
  const name = url.split("/").pop();
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) {
    // Validate before trusting (#477): a truncated or unreadable entry — an
    // interrupted first download, artifacts of earlier code versions — used
    // to be served as-is and fail EVERY subsequent run, unrecoverable short
    // of the user clearing browser storage by hand.
    try {
      const buf = await hit.arrayBuffer();
      const sidecar = await cache.match(url + LEN_SUFFIX);
      const expected = (sidecar && Number(await sidecar.text()))
        || Number(hit.headers.get("content-length")) || null;
      if (expected !== null && buf.byteLength !== expected) {
        throw new Error(`${buf.byteLength} bytes where ${expected} were expected`);
      }
      console.log(`Parakeet: ${name} — from cache`);
      onProgress(url, 1, 1);
      return { bytes: new Uint8Array(buf), fromCache: true };
    } catch (e) {
      console.warn(`Parakeet: corrupt cached ${name} (${e?.message || e}) — cache entry evicted, re-downloading`);
      await evictCached(url);
    }
  }
  console.log(`Parakeet: downloading ${name}…`);
  if (await streamDownloadToCache(cache, url, onProgress)) {
    const stored = await cache.match(url);
    if (stored) return { bytes: new Uint8Array(await stored.arrayBuffer()), fromCache: false };
  }
  console.warn("Cache Storage unavailable — downloading model to memory for this session.");
  return { bytes: await downloadToMemory(url, onProgress), fromCache: false };
}

// Common request setup: bypass the browser HTTP cache (we keep our own copy in
// Cache Storage; a duplicate disk-cache entry only wastes space and, with HF's
// redirect to a signed CDN url, causes flaky partial reads). Returns the
// response, or null to signal "retry", or throws on a fatal status.
async function openModelStream(url) {
  let resp;
  try {
    resp = await fetch(url, { cache: "no-store" });
  } catch (e) {
    return null;   // couldn't open the connection — retry
  }
  if (!resp.ok) {
    if (resp.status >= 500 || resp.status === 429) return null;   // transient — retry
    throw new Error(`Download failed (${resp.status}) for ${url.split("/").pop()}`);
  }
  return resp;
}

// Stream the download through a byte counter directly into the Cache. Returns
// true once stored; false if the cache itself can't be written (→ caller falls
// back to memory). Retries the whole file on a transient network drop.
async function streamDownloadToCache(cache, url, onProgress) {
  for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    const resp = await openModelStream(url);
    if (resp === null) continue;
    const total = Number(resp.headers.get("content-length")) || 0;
    let loaded = 0;
    const counter = new TransformStream({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        onProgress(url, loaded, total);
        controller.enqueue(chunk);
      },
    });
    try {
      // The browser consumes this stream into (disk-backed) storage; chunks pass
      // through the counter without being retained, so JS heap stays flat.
      const body = new Response(resp.body.pipeThrough(counter), {
        headers: total ? { "content-length": String(total) } : {},
      });
      await cache.put(url, body);
      // cache.put resolved, so the stream is fully consumed and `loaded` is
      // the delivered byte count — the sidecar the read-time validation
      // compares against (#477). Content-length can be absent or wrong
      // through HF's redirects; what we counted is the truth.
      try { await cache.put(url + LEN_SUFFIX, new Response(String(loaded))); } catch (_) {}
      return true;
    } catch (e) {
      try { await evictCached(url); } catch (_) {}   // drop any partial entry
      if (e?.name === "QuotaExceededError" || /quota|internal error/i.test(e?.message || "")) {
        return false;   // cache can't hold it — let the caller use memory
      }
      // otherwise treat as a mid-stream drop and retry the whole file
    }
  }
  throw new Error("Model download interrupted — please check your connection.");
}

// Fallback when Cache Storage is unavailable: download into memory (this session
// only, re-downloaded next time). Higher peak, but better than failing outright.
async function downloadToMemory(url, onProgress) {
  for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    const resp = await openModelStream(url);
    if (resp === null) continue;
    const total = Number(resp.headers.get("content-length")) || 0;
    try {
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
      return bytes;
    } catch (e) {
      // stream dropped — retry the whole file
    }
  }
  throw new Error("Model download interrupted — please check your connection.");
}

// Aggregate download progress across the model files (encoder dominates). `kind`
// ("GPU"/"CPU") is surfaced to the user and the console so it's clear which model
// build is being fetched — and obvious if both ever download in one session.
function makeDownloadProgress(kind) {
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
      self.postMessage({ type: "progress", phase: "download", kind, progress: percent });
    }
  };
}

async function loadSessions(forceGpu) {
  const ua = self.navigator?.userAgent || "";
  const isFirefox = /firefox/i.test(ua);
  // Safari (desktop or iOS), excluding the other engines that also say "Safari".
  const isSafari = /safari/i.test(ua) && !/chrome|chromium|crios|edg|opr|android|fxios/i.test(ua);
  // Default: WebGPU (fp16) only on engines where it's safe and fast (Chromium).
  // Firefox's WebGPU underperforms here, and Safari's stands the 1.24 GB fp16
  // encoder up in unified memory and has spiked the whole machine into swap — a
  // hard OS lockup on the very first window — so both default to the smaller
  // int8 encoder on WASM. The user can explicitly opt in to the GPU path
  // (forceGpu) despite the warning, which is how we gather real-world cases for
  // browser makers; an adapter must still exist for it to take effect.
  const useWebGpu = (forceGpu || (!isFirefox && !isSafari)) && (await hasGpuAdapter());
  const kind = useWebGpu ? "GPU" : "CPU";
  const onProgress = makeDownloadProgress(kind);

  // mel + decoder always run on WASM (decoder loop is sequential and cheap –
  // keeping it off the GPU avoids per-token round-trips). These three files are
  // ~20 MB combined vs the ~650 MB–1.2 GB encoder, so they download without a
  // progress callback: counting them would make the bar race to 100% and then
  // reset to ~0 once the encoder's far larger content-length enters the total.
  const noProgress = () => {};
  const [melFetched, decFetched, vocabFetched] = await Promise.all([
    fetchModel(MODELS.mel, noProgress),
    fetchModel(MODELS.decoder, noProgress),
    fetchModel(MODELS.vocab, noProgress),
  ]);
  const mel = await createSessionWithHeal(MODELS.mel, melFetched, { executionProviders: ["wasm"] });
  const decoder = await createSessionWithHeal(MODELS.decoder, decFetched, { executionProviders: ["wasm"] });
  const vocab = new TextDecoder().decode(vocabFetched.bytes).split("\n").map((l) => l.slice(0, l.lastIndexOf(" ")));

  let encoder, device, dtype;
  if (useWebGpu) {
    try {
      const encFetched = await fetchModel(MODELS.encoderFp16, onProgress);
      self.postMessage({ type: "progress", phase: "prepare", kind: "GPU" });
      // create-failure heals the cache (#477); a warm-up failure is a
      // CAPABILITY problem (#459) and falls through to int8 as before —
      // healing there would re-download 1.2 GB to hit the same wall.
      encoder = await createSessionWithHeal(MODELS.encoderFp16, encFetched,
        { executionProviders: ["webgpu"] }, onProgress);
      await warmUp(encoder);
      device = "webgpu"; dtype = "fp16";
    } catch (e) {
      console.warn("WebGPU encoder unavailable, falling back to WASM/int8:", e?.message || e);
      // Non-fatal by definition — the int8 path is about to run (#529). Tell
      // the page so the loader says so, instead of it inferring doom from
      // stray uncaught errors the dying GPU path may have emitted.
      self.postMessage({ type: "fallback", message: "GPU unavailable — retrying on the CPU" });
      encoder = null;
    }
  }
  if (!encoder) {
    // Fresh CPU-labelled progress so a GPU→CPU fallback reads as a distinct
    // "Downloading CPU model…" pass rather than continuing the GPU one.
    const onProgressCpu = makeDownloadProgress("CPU");
    const encFetched = await fetchModel(MODELS.encoderInt8, onProgressCpu);
    self.postMessage({ type: "progress", phase: "prepare", kind: "CPU" });
    encoder = await createSessionWithHeal(MODELS.encoderInt8, encFetched,
      { executionProviders: ["wasm"] }, onProgressCpu);
    device = "wasm"; dtype = "int8";
  }

  console.log(`Parakeet ready on ${device} (${dtype})`);
  self.postMessage({ type: "device", device, dtype });
  return { mel, encoder, decoder, vocab, device };
}

// Session creation that heals a poisoned cache (#477): if create throws on
// bytes that CAME FROM the cache, the entry is evicted and fetched fresh from
// the network for one more attempt — corruption with a plausible length
// passes the read-time check and lands here. Bytes that were just downloaded
// implicate the network or the model itself, not the cache: no retry.
async function createSessionWithHeal(url, fetched, opts, onProgress) {
  try {
    return await ort.InferenceSession.create(fetched.bytes, opts);
  } catch (e) {
    if (!fetched.fromCache) throw e;
    console.warn(`Parakeet: session creation failed on cached ${url.split("/").pop()} — cache entry evicted, retrying from network (${e?.message || e})`);
    await evictCached(url);
    const fresh = await fetchModel(url, onProgress || (() => {}));
    return await ort.InferenceSession.create(fresh.bytes, opts);
  }
}

// Push a short silent clip through the encoder so WebGPU shader compilation
// (and any inference-time failure) happens now, under "Preparing model…".
// WebGPU raises validation errors asynchronously — run() resolves even when
// every pipeline failed to compile — so the warm-up runs inside an error
// scope and throws on a captured error, which sends loadSessions down the
// int8/WASM fallback instead of "succeeding" into a blank transcript (#459).
async function warmUp(encoder) {
  const device = ort.env.webgpu?.device;
  device?.pushErrorScope("validation");
  const len = 100;
  await encoder.run({
    audio_signal: new ort.Tensor("float32", new Float32Array(128 * len), [1, 128, len]),
    length: new ort.Tensor("int64", BigInt64Array.from([BigInt(len)]), [1]),
  });
  const gpuError = device ? await device.popErrorScope() : null;
  if (gpuError) {
    throw new Error(`WebGPU validation failed during warm-up: ${gpuError.message}`);
  }
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
    if (i === 0) {
      words = windowWords;
    } else {
      // both windows transcribe the OVERLAP_S overlap [offsetSeconds, offsetSeconds+OVERLAP_S];
      // cut at its midpoint so each word survives exactly once (time-based, so
      // legitimate within-window repeats are untouched)
      const cut = offsetSeconds + OVERLAP_S / 2;
      words = words.filter((w) => w.start < cut).concat(windowWords.filter((w) => w.start >= cut));
    }
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
  // Every ort.Tensor we create or receive holds a buffer (a GPU buffer on the
  // WebGPU path). Without explicit dispose() they only go when GC runs, which on
  // Safari is far too late — memory ratchets up window-over-window until the tab
  // is killed. So we release each one the moment we're done with it.

  // 1. mel features
  const wf = new ort.Tensor("float32", samples.slice(), [1, samples.length]);
  const wfLen = new ort.Tensor("int64", BigInt64Array.from([BigInt(samples.length)]), [1]);
  const mel = await s.mel.run({ waveforms: wf, waveforms_lens: wfLen });
  wf.dispose(); wfLen.dispose();
  // 2. encoder
  const encT0 = Date.now();
  const enc = await s.encoder.run({ audio_signal: mel.features, length: mel.features_lens });
  mel.features.dispose(); mel.features_lens.dispose();
  const encData = enc.outputs.data;            // [1, D, T'] (downloaded to CPU here)
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
    const encIn = new ort.Tensor("float32", frame(t), [1, D, 1]);
    const tgtIn = new ort.Tensor("int32", Int32Array.from([last]), [1, 1]);
    const tgtLenIn = new ort.Tensor("int32", Int32Array.from([1]), [1]);
    const r = await s.decoder.run({
      encoder_outputs: encIn,
      targets: tgtIn,
      target_length: tgtLenIn,
      input_states_1: s1,
      input_states_2: s2,
    });
    const o = r.outputs.data;
    let tok = 0, bv = -Infinity;
    for (let i = 0; i < VOCAB_SIZE; i++) if (o[i] > bv) { bv = o[i]; tok = i; }
    let step = 0, dv = -Infinity;
    for (let i = VOCAB_SIZE; i < o.length; i++) if (o[i] > dv) { dv = o[i]; step = i - VOCAB_SIZE; }
    if (tok !== BLANK) {
      // adopt the new states; release the ones they replace
      s1.dispose(); s2.dispose();
      s1 = r.output_states_1; s2 = r.output_states_2;
      tokens.push(tok); stamps.push(t); last = tok; emitted++;
    } else {
      // states unchanged this step — the fresh outputs are dead, drop them
      r.output_states_1.dispose(); r.output_states_2.dispose();
    }
    r.outputs.dispose();
    encIn.dispose(); tgtIn.dispose(); tgtLenIn.dispose();
    if (step > 0) { t += step; emitted = 0; }
    else if (tok === BLANK || emitted === MAX_SYMBOLS) { t += 1; emitted = 0; }
  }
  s1.dispose(); s2.dispose();
  enc.outputs.dispose(); enc.encoded_lengths.dispose();

  console.log(`  window: encoder ${encMs}ms, decode ${Date.now() - decT0}ms (${encLen} frames)`);

  // 4. tokens -> words (▁ marks a word start); times offset by window start.
  // Punctuation-only tokens (. , ? ! …) are emitted AFTER the model has heard
  // the following pause — it concludes the sentence ended partly BECAUSE
  // silence follows — so extending the word's end to their emission frame
  // would absorb that pause into the word's duration (#372: "cast." with
  // data-d="2640"). Merge their text but keep the end of the last LEXICAL
  // token, so durations stay honest and post-sentence pauses remain real
  // inter-word gaps (which gap skipping can then catch).
  const PUNCT_ONLY = /^[.,!?;:…'"’”„«»()\[\]{}%\-–—]+$/;
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
      if (!PUNCT_ONLY.test(piece)) {
        cur.end = sec + FRAME_SEC;
      }
    }
  }
  if (cur) words.push(cur);
  return words;
}


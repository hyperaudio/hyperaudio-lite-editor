/**
 * whisper.worker.js
 * (C) The Hyperaudio Project
 * @version 0.6.7 — last changed in release 0.6.7
 * @license MIT
 */

import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

const SAMPLE_RATE = 16000;
const WINDOW_S = 300;   // transcribe in 5-minute windows to bound memory
const OVERLAP_S = 10;   // each seam is transcribed by both windows

let cache = { key: null, pipe: null, device: null };

self.addEventListener("message", async (event) => {
  const { type, audio, model_name } = event.data;

  if (type !== "INFERENCE_REQUEST") {
    return;
  }

  // a language hint stops multilingual models re-detecting the language per
  // 30s chunk (which can drift into translating instead of transcribing).
  // English-only models reject the option, so it only applies to multilingual.
  const language = (event.data.language && !model_name.includes(".en")) ? event.data.language : null;

  let pipe;
  try {
    pipe = await getPipeline(model_name);
  } catch (e) {
    console.error(e);
    self.postMessage({ type: "error", stage: "load", message: e?.message || String(e) });
    return;
  }

  try {
    const output = await transcribe(pipe, audio, language);
    self.postMessage({ type: "result", output });
  } catch (e) {
    console.error(e);
    // WebGPU can pass pipeline init yet fail at inference time on some GPUs –
    // rebuild on WASM and retry once before giving up.
    if (cache.device === "webgpu") {
      try {
        pipe = await getPipeline(model_name, ["wasm"]);
        const output = await transcribe(pipe, audio, language);
        self.postMessage({ type: "result", output });
        return;
      } catch (retryError) {
        console.error(retryError);
        self.postMessage({ type: "error", stage: "transcribe", message: retryError?.message || String(retryError) });
        return;
      }
    }
    self.postMessage({ type: "error", stage: "transcribe", message: e?.message || String(e) });
  }
});

// Preferred dtype first, then a fallback: the quantized exports of some of the
// *_timestamped models predate the v4 ONNX runtime and fail session creation
// ("Missing required scale ... MatMulNBits"), so always keep a variant in the
// list that loads everywhere – fp32, except for turbo where fp32 is 2.5 GB.
// navigator.gpu existing does not mean a usable GPU exists (headless and
// GPU-less machines expose the API but yield no adapter) – and a failed
// webgpu attempt poisons every later device attempt in the same worker, so
// it must be ruled out before trying, not after failing.
async function hasGpuAdapter() {
  try {
    if (!self.navigator?.gpu) {
      return false;
    }
    const adapter = await self.navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch (e) {
    return false;
  }
}

function pickDtypes(model_name, device) {
  if (model_name.includes("large-v3-turbo")) {
    return ["q4f16", "q4"];
  }
  if (device === "webgpu") {
    // fp16 whisper decoders are numerically fragile and prone to repetition
    // loops – use the same per-component dtypes as the official demos.
    return [{ encoder_model: "fp32", decoder_model_merged: "q4" }, "fp32"];
  }
  // On the WASM runtime, q4 is the only quantized variant of the
  // *_timestamped exports that loads – q8/int8/uint8 fail session creation
  // ("Missing required scale ... MatMulNBits", huggingface/transformers.js
  // #1707) and fp16 fails with a graph error. q4 verified on tiny, base and
  // small; it is also a quarter of fp32's size, which matters because very
  // large downloads have proven fragile on flaky connections.
  return ["q4", "fp32"];
}

async function getPipeline(model_name, devices) {
  if (devices === undefined) {
    // Firefox's WebGPU initialises and completes but is far slower than its
    // own WASM path (measured 2026-06: minutes vs 13s for the same clip) –
    // prefer WASM there until its implementation matures
    const slowWebGpu = /firefox/i.test(self.navigator?.userAgent || "");
    devices = !slowWebGpu && (await hasGpuAdapter()) ? ["webgpu", "wasm"] : ["wasm"];
  }

  let lastError = null;
  for (const device of devices) {
    for (const dtype of pickDtypes(model_name, device)) {
      const dtypeLabel = typeof dtype === "string" ? dtype : JSON.stringify(dtype);
      const key = `${model_name}|${device}|${dtypeLabel}`;

      if (cache.key === key && cache.pipe !== null) {
        return cache.pipe;
      }

      // free the previous model's (GPU) memory before loading the next one
      if (cache.pipe !== null) {
        try {
          await cache.pipe.dispose();
        } catch (e) {
          console.warn("Failed to dispose previous pipeline:", e);
        }
        cache = { key: null, pipe: null, device: null };
      }

      try {
        const pipe = await pipeline("automatic-speech-recognition", model_name, {
          device,
          dtype,
          progress_callback: makeDownloadProgress(),
        });

        let warmupSeconds = null;
        if (device === "webgpu") {
          // run one second of silence through the pipeline so that shader
          // compilation happens here, under "Preparing model…", rather than
          // inside the first transcription window – and so a GPU that fails
          // at inference time is caught now, while falling through to WASM
          // is still cheap. The duration doubles as a quality probe of this
          // browser's WebGPU implementation.
          self.postMessage({ type: "progress", phase: "prepare" });
          const warmupStart = Date.now();
          await pipe(new Float32Array(SAMPLE_RATE));
          warmupSeconds = (Date.now() - warmupStart) / 1000;
        }

        cache = { key, pipe, device };

        console.log(`Whisper pipeline ready: ${model_name} on ${device} (${dtypeLabel})`
          + (warmupSeconds !== null ? `, warm-up ${warmupSeconds.toFixed(1)}s` : ""));
        self.postMessage({ type: "device", device, dtype: dtypeLabel });
        return pipe;
      } catch (e) {
        console.warn(`Failed to initialise ${model_name} on ${device} (${dtypeLabel}):`, e);
        lastError = e;
      }
    }
  }
  throw lastError || new Error("No usable inference device");
}

function makeDownloadProgress() {
  const files = new Map();
  let lastPercent = -1;

  return (info) => {
    if (info.status !== "progress" || !info.total) {
      return;
    }
    files.set(info.file, { loaded: info.loaded, total: info.total });

    let loaded = 0, total = 0;
    files.forEach((f) => { loaded += f.loaded; total += f.total; });

    const percent = Math.floor((loaded / total) * 100);
    if (percent !== lastPercent) {
      lastPercent = percent;
      self.postMessage({ type: "progress", phase: "download", progress: percent });
    }
  };
}

async function transcribe(pipe, audio, language) {
  const startedAt = Date.now();
  const windowSamples = WINDOW_S * SAMPLE_RATE;
  const stepSamples = (WINDOW_S - OVERLAP_S) * SAMPLE_RATE;
  const windowCount = audio.length <= windowSamples
    ? 1
    : Math.ceil((audio.length - windowSamples) / stepSamples) + 1;

  let chunks = [];

  for (let i = 0; i < windowCount; i++) {
    // announce the window before running it – otherwise nothing updates the
    // loader between the model download and the first completed window, and
    // it shows a stale "Downloading model" for the whole first inference.
    // progress is only countable across windows, so a single-window file
    // (under 5 minutes) gets no percentage – the elapsed clock carries it
    self.postMessage({
      type: "progress",
      phase: "transcribe",
      progress: windowCount > 1 ? Math.round((i / windowCount) * 100) : null,
    });

    const offsetSamples = i * stepSamples;
    const offsetSeconds = offsetSamples / SAMPLE_RATE;
    const window = audio.subarray(offsetSamples, offsetSamples + windowSamples);

    const output = await pipe(window, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(language !== null ? { language } : {}),
    });

    const windowChunks = dropRewindDuplicates((output.chunks || []).map((chunk) => {
      const start = chunk.timestamp[0] + offsetSeconds;
      // the final word of a window can come back with a null end timestamp
      const end = (chunk.timestamp[1] ?? chunk.timestamp[0] + 0.5) + offsetSeconds;
      return { text: chunk.text, timestamp: [start, end] };
    }));

    chunks = i === 0 ? windowChunks : stitch(chunks, windowChunks, offsetSeconds);
    chunks = collapseRepeats(chunks);

    self.postMessage({
      type: "progress",
      phase: "transcribe",
      progress: windowCount > 1 ? Math.round(((i + 1) / windowCount) * 100) : null,
    });
  }

  chunks = collapseCycles(mergeWordFragments(chunks));

  const seconds = (Date.now() - startedAt) / 1000;
  console.log(`Whisper transcription took ${seconds.toFixed(1)}s for ${(audio.length / SAMPLE_RATE).toFixed(1)}s of audio (${cache.device})`);

  return { text: chunks.map((c) => c.text).join(""), chunks, seconds };
}

// Whisper marks the start of a word with a leading space on the chunk text; a
// chunk without one ("-to", "-text" in "speech-to-text") is a fragment of the
// word before it. Merge fragments into their parent so hyphenated words render
// as one timed span instead of "speech -to -text".
function mergeWordFragments(chunks) {
  const out = [];
  for (const chunk of chunks) {
    const prev = out[out.length - 1];
    if (prev !== undefined && !chunk.text.startsWith(" ")) {
      prev.text += chunk.text;
      prev.timestamp = [prev.timestamp[0], chunk.timestamp[1]];
    } else {
      out.push({ text: chunk.text, timestamp: [...chunk.timestamp] });
    }
  }
  return out;
}

// transformers.js merges its internal 30s chunks by matching tokens across the
// seam; when the two decodes of the overlap disagree the merge can fail and a
// stretch of words is emitted twice. The re-emit starts with word timestamps
// rewinding – something real speech never does – so on a rewind of more than a
// second, drop back to where the re-decode begins and let the later decode
// (which carries on into the following audio) win.
function dropRewindDuplicates(chunks) {
  const out = [];
  for (const chunk of chunks) {
    const start = chunk.timestamp[0];
    if (out.length > 0 && start < out[out.length - 1].timestamp[0] - 1.0) {
      while (out.length > 0 && out[out.length - 1].timestamp[0] >= start - 0.2) {
        out.pop();
      }
    }
    out.push(chunk);
  }
  return out;
}

// A looping decoder can also creep its timestamps forward, emitting the same
// word cycle over and over at slightly advancing times – invisible to the
// same-instant collapse below. Real speech essentially never repeats the
// identical word sequence many times back to back with identical punctuation,
// so collapse such runs to their first occurrence. Single-word cycles need a
// higher bar ("no, no, no" is legitimate speech).
function collapseCycles(chunks) {
  const texts = chunks.map((c) => c.text.trim().toLowerCase());

  const cycleMatches = (start, candidate, n) => {
    if (candidate + n > texts.length) {
      return false;
    }
    for (let k = 0; k < n; k++) {
      if (texts[start + k] !== texts[candidate + k]) {
        return false;
      }
    }
    return true;
  };

  const out = [];
  let i = 0;
  while (i < chunks.length) {
    let collapsed = false;
    // smallest period first, so "a b a b a b" collapses as the 2-cycle
    for (let n = 1; n <= 8 && !collapsed; n++) {
      let reps = 1;
      while (cycleMatches(i, i + reps * n, n)) {
        reps++;
      }
      const minReps = n === 1 ? 6 : 4;
      if (reps >= minReps) {
        for (let k = 0; k < n; k++) {
          out.push(chunks[i + k]);
        }
        console.log(`Collapsed repetition loop: "${chunks.slice(i, i + n).map((c) => c.text.trim()).join(" ")}" × ${reps}`);
        i += reps * n;
        collapsed = true;
      }
    }
    if (!collapsed) {
      out.push(chunks[i]);
      i++;
    }
  }
  return out;
}

// When the whisper decoder gets stuck in a repetition loop its word-timestamp
// prediction collapses too: dozens of words come back with the identical start
// time. Real speech never starts two words at the same instant, so within each
// run of same-start chunks keep only the first occurrence of each word.
function collapseRepeats(chunks) {
  const out = [];
  let runStart = null;
  let seen = null;
  for (const chunk of chunks) {
    if (chunk.timestamp[0] !== runStart) {
      runStart = chunk.timestamp[0];
      seen = new Set();
    }
    const key = chunk.text.trim().toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(chunk);
  }
  return out;
}

// Join two overlapping windows at a word boundary: find the inter-word gap in
// the previous window's output closest to the overlap midpoint and cut there,
// so the seam always falls in silence between words, never mid-word.
function stitch(prevChunks, nextChunks, overlapStart) {
  const overlapEnd = overlapStart + OVERLAP_S;
  const midpoint = overlapStart + OVERLAP_S / 2;

  let cut = midpoint;
  let bestDistance = Infinity;
  for (let i = 1; i < prevChunks.length; i++) {
    const gapStart = prevChunks[i - 1].timestamp[1];
    const gapEnd = prevChunks[i].timestamp[0];
    if (gapEnd < overlapStart || gapStart > overlapEnd) {
      continue;
    }
    const gapMiddle = (gapStart + gapEnd) / 2;
    const distance = Math.abs(gapMiddle - midpoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      cut = gapMiddle;
    }
  }

  return prevChunks
    .filter((c) => c.timestamp[1] <= cut)
    .concat(nextChunks.filter((c) => c.timestamp[0] > cut));
}

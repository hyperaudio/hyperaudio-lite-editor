/**
 * whisper.worker.js
 * (C) The Hyperaudio Project
 * @version 0.6.6 — last changed in release 0.6.6
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

  let pipe;
  try {
    pipe = await getPipeline(model_name);
  } catch (e) {
    console.error(e);
    self.postMessage({ type: "error", stage: "load", message: e?.message || String(e) });
    return;
  }

  try {
    const output = await transcribe(pipe, audio);
    self.postMessage({ type: "result", output });
  } catch (e) {
    console.error(e);
    // WebGPU can pass pipeline init yet fail at inference time on some GPUs –
    // rebuild on WASM and retry once before giving up.
    if (cache.device === "webgpu") {
      try {
        pipe = await getPipeline(model_name, ["wasm"]);
        const output = await transcribe(pipe, audio);
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
function pickDtypes(model_name, device) {
  if (model_name.includes("large-v3-turbo")) {
    return ["q4f16", "q4"];
  }
  if (device === "webgpu") {
    // fp16 whisper decoders are numerically fragile and prone to repetition
    // loops – use the same per-component dtypes as the official demos.
    return [{ encoder_model: "fp32", decoder_model_merged: "q4" }, "fp32"];
  }
  return ["q8", "fp32"];
}

async function getPipeline(model_name, devices) {
  if (devices === undefined) {
    devices = self.navigator?.gpu ? ["webgpu", "wasm"] : ["wasm"];
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

        cache = { key, pipe, device };

        console.log(`Whisper pipeline ready: ${model_name} on ${device} (${dtypeLabel})`);
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

async function transcribe(pipe, audio) {
  const windowSamples = WINDOW_S * SAMPLE_RATE;
  const stepSamples = (WINDOW_S - OVERLAP_S) * SAMPLE_RATE;
  const windowCount = audio.length <= windowSamples
    ? 1
    : Math.ceil((audio.length - windowSamples) / stepSamples) + 1;

  let chunks = [];

  for (let i = 0; i < windowCount; i++) {
    const offsetSamples = i * stepSamples;
    const offsetSeconds = offsetSamples / SAMPLE_RATE;
    const window = audio.subarray(offsetSamples, offsetSamples + windowSamples);

    const output = await pipe(window, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
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
      progress: Math.round(((i + 1) / windowCount) * 100),
    });
  }

  chunks = mergeWordFragments(chunks);

  return { text: chunks.map((c) => c.text).join(""), chunks };
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

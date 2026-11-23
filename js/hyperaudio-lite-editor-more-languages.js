/**
 * hyperaudio-lite-editor-more-languages.js
 * (C) The Hyperaudio Project
 * @version 1.3.53 — last changed in release 1.3.53
 * @license AGPL-3.0-only
 *
 * The More languages tab (#815): speech-to-text models made for one language
 * each, run in the browser by js/more-languages.worker.js, with the result
 * turned into words by js/converters/wav2vec2.js. The first is Swecha
 * Gonthuka for Telugu. The tab is experimental: it is in the page only while
 * Settings ▸ Application ▸ Experimental features is on.
 *
 * To remove it: delete this file, the worker, the converter, their script
 * tags and PRECACHE entries, the template and the tab in index.html, and the
 * more-languages ids in the lists named in docs/adding-an-stt-engine.md.
 */

// The models this tab offers, in the order the select lists them. `value` is
// the id the worker knows (MODELS in more-languages.worker.js), `modelId` and
// `revision` the files it runs, recorded in the project's provenance, and
// `repos` the start of their URLs, so Settings can name the cached model.
const MORE_LANGUAGES_MODELS = [
  { value: "swecha-gonthuka-te", label: "Telugu – Swecha Gonthuka", model: "Swecha Gonthuka", language: "Telugu", languageCode: "te",
    modelId: "therajasekhar/swecha-gonthuka-asr-ONNX", revision: "66a830174695d3a10369d21619f5dd8eb5158ed2", dtype: "fp16",
    storeLabel: "Swecha Gonthuka · Telugu", repos: ["therajasekhar/swecha-gonthuka-asr-ONNX"] },
];

// Where the worker keeps the downloaded models (#615), so Settings can size
// and remove them. Must match CACHE_NAME in more-languages.worker.js.
(window.HyperaudioModelStores = window.HyperaudioModelStores || []).push({
  engine: 'More languages',
  cacheName: 'more-languages-models-v1',
  label: (url) => {
    const owner = MORE_LANGUAGES_MODELS.find((m) => m.repos.some((repo) => String(url).indexOf('https://huggingface.co/' + repo + '/') === 0));
    return owner ? owner.storeLabel : MORE_LANGUAGES_MODELS[0].storeLabel;
  },
});

class MoreLanguagesService extends HTMLElement {
  connectedCallback() {
    // built and wired once, should the element ever be moved and reconnected
    if (this.dataset.ready === 'true') return;
    const template = document.querySelector(this.getAttribute("templateSelector"));
    if (template === null) return;
    this.innerHTML = template.innerHTML;
    template.remove();
    this.dataset.ready = 'true';
    loadMoreLanguagesClient(this, this.getAttribute("workerBaseUrl") || "./");
  }
}

customElements.define('client-more-languages-service', MoreLanguagesService);

function loadMoreLanguagesClient(modal, workerBaseUrl) {
  const fileInput = modal.querySelector("#more-languages-file");
  const mediaUrlInput = modal.querySelector("#more-languages-media");
  const submitBtn = modal.querySelector("#more-languages-submit-btn");
  const modelSelect = modal.querySelector("#more-languages-model");
  const deviceLabel = modal.querySelector("#more-languages-device");
  const workerPath = workerBaseUrl + "js/more-languages.worker.js?v=1.3.52";

  MORE_LANGUAGES_MODELS.forEach((m) => {
    const option = document.createElement("option");
    option.value = m.value;
    option.textContent = m.label;
    modelSelect.appendChild(option);
  });
  modelSelect.value = MORE_LANGUAGES_MODELS[0].value;
  const chosenModel = () => MORE_LANGUAGES_MODELS.find((m) => m.value === modelSelect.value) || MORE_LANGUAGES_MODELS[0];

  // the submit is a styled <label>, so "disabled" is the btn-disabled class
  function updateSubmitState() {
    const ready = fileInput.files.length > 0 || (mediaUrlInput !== null && mediaUrlInput.value.trim() !== "");
    submitBtn.classList.toggle("btn-disabled", !ready);
    submitBtn.setAttribute("aria-disabled", String(!ready));
  }
  fileInput.addEventListener("change", updateSubmitState);
  if (mediaUrlInput !== null) mediaUrlInput.addEventListener("input", updateSubmitState);
  updateSubmitState();

  submitBtn.addEventListener("click", () => {
    if (submitBtn.classList.contains("btn-disabled")) return;
    start();
  });

  // The worker is made on demand and terminated after ten idle minutes, as
  // the local Parakeet's is (#550): wasm memory never shrinks while it lives.
  let worker = null;
  let idleTimer = null;
  const IDLE_TERMINATE_MS = window.MORE_LANGUAGES_WORKER_IDLE_MS || 10 * 60 * 1000;
  function retireLater() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (worker === null) return;
      worker.terminate();
      worker = null;
    }, IDLE_TERMINATE_MS);
  }

  let pending = null;     // { model, info, startedAt }
  let message = "";
  let clockStart = 0;
  let clock = null;

  const elapsed = (ms) => {
    const s = Math.floor(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  };
  // the loader keeps its node, which the library moves aside and back when
  // the user switches project, so it is looked up each time (null-guarded)
  function paint() {
    const el = document.querySelector("#hypertranscript .transcribing-msg");
    if (el !== null) el.innerHTML = `${message} <span style="font-size:80%; opacity:0.55">(${elapsed(Date.now() - clockStart)})</span>`;
  }
  function say(text) { message = text; paint(); }
  function stopClock() { clearInterval(clock); clock = null; }

  // A percentage that moves within each window (#676): the shared tracker
  // counts a window up by time, against how long the last one took per
  // second of audio, as it does for Whisper's windows.
  let tracker = null;
  let device = "wasm";    // from the worker's last "device" message
  function showTranscribeProgress() {
    if (tracker !== null) say(`Transcribing… ${tracker.percent()}%`);
  }

  // The shown percentage trails the facts, so the result would close the
  // loader on 80-odd: count the rest of the way to 100 in well under a
  // second first, as the Whisper and Parakeet clients do, by the clock and
  // not at all in a hidden tab, whose timers barely fire.
  function finishProgress(then) {
    stopClock();
    const from = tracker !== null && /^Transcribing…/.test(message) ? tracker.inspect().shown : 100;
    if (from >= 100 || document.hidden) { then(); return; }
    const stepMs = Math.min(100, Math.floor(600 / (100 - from)));
    const started = Date.now();
    const finisher = setInterval(() => {
      const shown = Math.min(100, from + Math.floor((Date.now() - started) / stepMs));
      say(`Transcribing… ${shown}%`);
      if (shown === 100) { clearInterval(finisher); setTimeout(then, 250); }
    }, stepMs);
  }

  function createWorker() {
    const w = new Worker(workerPath, { type: "module" });
    w.onmessage = (event) => {
      const data = event.data;
      if (data.type === "progress") {
        if (data.phase !== "transcribe") say(data.phase === "download" ? `Downloading model… ${data.progress === null ? "" : data.progress + "%"}`
          : data.phase === "prepare" ? "Preparing model…"
            : null);
        if (data.phase === "transcribe") {
          if (tracker === null && typeof window.createTranscriptionProgressTracker === "function") {
            tracker = window.createTranscriptionProgressTracker({ device });
          }
          if (tracker !== null && data.detail) { tracker.on(data.detail); showTranscribeProgress(); }
          else say(`Transcribing… ${data.progress}%`);
        }
      } else if (data.type === "device") {
        // a new device is a new pace: the tracker starts again from its guess
        if (data.device !== device) tracker = null;
        device = data.device;
        const label = device === "webgpu" ? "GPU (WebGPU)" : "CPU";
        if (pending !== null) pending.info.device = label;
        if (deviceLabel !== null) deviceLabel.textContent = `Running on the ${label}`;
      } else if (data.type === "fallback") {
        tracker = null;
        say(data.message || "Retrying on the CPU…");
      } else if (data.type === "result") {
        retireLater();
        finishProgress(() => finish(data.output));
      } else if (data.type === "error") {
        retireLater();
        fail(data.message, data.stage);
      }
    };
    // only a worker that cannot load, or one the browser killed for memory,
    // gets here: the worker reports its own failures as messages
    w.onerror = (event) => {
      console.error(event);
      w.terminate();
      if (worker === w) worker = null;
      fail(event.message || "Transcription stopped unexpectedly. With long media this is usually the browser running out of memory – try a shorter file.");
    };
    return w;
  }

  async function start() {
    clearTimeout(idleTimer);
    if (worker === null) worker = createWorker();
    document.querySelector('#transcript-editor-btn')?.click();

    const file = fileInput.files[0];
    const mediaUrl = mediaUrlInput !== null ? mediaUrlInput.value.trim() : "";
    const useUrl = (file === undefined || file === null) && mediaUrl !== "";
    const model = chosenModel();
    pending = {
      model,
      info: {
        service: "More languages (local, in your browser)",
        model: `${model.model} (${model.language})`,
        language: model.language,
        languageCode: model.languageCode,
        modelId: model.modelId,
        parameters: { model: model.value, revision: model.revision, dtype: model.dtype },
        runtime: "onnxruntime-web",
        engineVersion: "1.26.0",
      },
      startedAt: Date.now(),
    };

    // the media on the player first: the library captures it at the busy signal
    const player = document.querySelector("#hyperplayer");
    if (!useUrl) {
      player.src = URL.createObjectURL(file);
    } else {
      if (typeof detachHls === "function") detachHls(player);
      player.src = mediaUrl;
    }
    document.querySelector('#transcribe-dialog')?.close?.();

    const first = useUrl ? "Reading the media from the URL…" : "Preparing model…";
    if (typeof showTranscriptNotice === "function") {
      showTranscriptNotice('<div class="vertically-centre"><center class="transcribing-msg">' + first + '</center><br/><img src="' + transcribingSvg + '" width="50" alt="transcribing" style="margin: auto; display: block;"></div>');
    }
    if (typeof setTranscriptBusy === "function") setTranscriptBusy(true);
    clockStart = Date.now();
    message = first;
    stopClock();
    tracker = null;
    // a tenth-of-a-second tick keeps the percentage moving between reports
    clock = setInterval(() => (tracker !== null && /^Transcribing…/.test(message) ? showTranscribeProgress() : paint()), 100);

    let audio;
    try {
      audio = useUrl
        ? await readAudioFromUrl(mediaUrl, player, (p) => say(`Downloading audio… ${p}%`))
        : await decodeToMono16k(file);
    } catch (e) {
      console.error(e);
      fail(useUrl ? (e.message || "Could not load audio from the URL.") : "Could not decode the media file.", "media");
      return;
    }
    // Firefox's WebGPU is slower than its CPU path (see WEBGPU.md), so it
    // stays on the CPU; everywhere else the worker uses a GPU that can do fp16
    const preferGpu = !/firefox/i.test(navigator.userAgent);
    worker.postMessage({ type: "INFERENCE_REQUEST", audio, model: model.value, preferGpu }, [audio.buffer]);
  }

  function adviceFor(stage, text) {
    if (stage === "media") return "";
    if (stage === "load") {
      return /fetch|network|HTTP|status|Download/i.test(String(text || ""))
        ? "The model could not be downloaded. Check your connection and try again later."
        : "The model could not be loaded. Reload the page and try again.";
    }
    return "Reload the page and try again.";
  }

  function fail(text, stage) {
    stopClock();
    if (typeof setTranscriptBusy === "function") setTranscriptBusy(false);
    console.error("More languages error: " + text);
    const advice = adviceFor(stage, text);
    const detail = text ? '<br/><span style="font-size:80%; opacity:0.7">' + String(text).slice(0, 200).replace(/</g, '&lt;') + '</span>' : '';
    if (typeof showTranscriptNotice === "function") {
      showTranscriptNotice('<div class="vertically-centre"><img src="' + errorSvg + '" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>Transcription failed.' + (advice ? '<br/>' + advice : '') + detail + '</center></div>');
    }
  }

  function finish(output) {
    const converted = window.HyperaudioConverters.wav2vec2(output);
    // silence, or speech in another language, can come back as no words at
    // all: a failure to report, not an empty transcript to keep
    if (converted.words.length === 0) {
      fail("No words were produced. If this media has speech in the chosen language, transcription failed.", "transcribe");
      return;
    }
    const html = jsonToHTML({ words: converted.words, paragraphs: converted.paragraphs });
    const info = pending !== null ? { ...pending.info, seconds: (Date.now() - pending.startedAt) / 1000 } : null;
    const language = converted.language || (pending !== null ? pending.model.languageCode : "");

    // finished while another project is open: it goes to Recents (#715)
    const background = typeof window.hyperaudioTranscriptionInBackground === 'function' && window.hyperaudioTranscriptionInBackground();
    if (!background) {
      const track = document.querySelector('#hyperplayer-vtt');
      if (track) { track.label = language; track.srcLang = language; }
      const player = document.querySelector("#hyperplayer");
      // back to the start, only when it has left it: a move to where it already
      // is still counts as a seek, and after a seek a video shows its current
      // frame, often black, instead of its poster (#828)
      if (player.currentTime !== 0) player.currentTime = 0;
    }
    if (typeof window.hyperaudioKeepTranscription === 'function' && window.hyperaudioKeepTranscription({ html, info })) return;

    document.querySelector("#hypertranscript").innerHTML = html;
    document.querySelector('#download-html')?.setAttribute('href', 'data:text/html,' + encodeURIComponent(html));
    if (info !== null && typeof setTranscriptionInfo === "function") setTranscriptionInfo(info);
    if (typeof setTranscriptBusy === "function") setTranscriptBusy(false);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  }
}

/**
 * hyperaudio-lite-editor-parakeet-local.js
 * (C) The Hyperaudio Project
 * @version 1.3.46 — last changed in release 1.3.46
 * @license AGPL-3.0-only
 */

// The models this engine offers (#785), in the order the Model select lists
// them. `value` is the id the worker knows (MODEL_SETS in parakeet.worker.js),
// `modelId` the export it downloads, recorded in the project's provenance
// (#668), and `repo` the start of every URL in that export, which is how a
// cache entry is told to belong to this model. Ultra (moondream/parakeet-ultra)
// is a further-trained v3 with the same architecture and tokenizer, and the
// two stay side by side.
const PARAKEET_MODELS = [
  { value: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3", modelId: "istupakov/parakeet-tdt-0.6b-v3-onnx",
    storeLabel: "Parakeet TDT 0.6B v3 · multilingual", repos: ["istupakov/parakeet-tdt-0.6b-v3-onnx", "ako101/parakeet-tdt-0.6b-v3-sherpa-onnx-fp16"] },
  { value: "parakeet-tdt-0.6b-v3-ultra", label: "Parakeet TDT 0.6B Ultra", modelId: "Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx",
    storeLabel: "Parakeet TDT 0.6B Ultra · multilingual", repos: ["Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx"] },
];

// Where this engine keeps its downloaded models (#615), so Settings can size
// and remove them without knowing any engine. Must match CACHE_NAME in
// parakeet.worker.js, which owns the entries (and their length sidecars).
// Each cached file is labelled by the model whose repository served it, so
// Settings lists v3 and Ultra on their own and removes one without the other.
(window.HyperaudioModelStores = window.HyperaudioModelStores || []).push({
  engine: 'Parakeet',
  cacheName: 'parakeet-models-v1',
  label: (url) => {
    const owner = PARAKEET_MODELS.find((m) => m.repos.some((repo) => String(url).indexOf('https://huggingface.co/' + repo + '/') === 0));
    return owner ? owner.storeLabel : PARAKEET_MODELS[0].storeLabel;
  },
});

class ParakeetLocalService extends HTMLElement {

  constructor() {
    super();
  }

  connectedCallback() {

    let template = null;
    let modal = this;

    const templateUrl = this.getAttribute("templateUrl");
    const templateSelector = this.getAttribute("templateSelector");
    const workerBaseUrl = this.getAttribute("workerBaseUrl");

    if (templateUrl !== null) {
      fetch(templateUrl)
        .then(function(response) {
            return response.text()
        })
        .then(function(html) {
          let parser = new DOMParser();
          template = parser.parseFromString(html, "text/html");
          let parakeetTempl = template.querySelector('#parakeet-local-template').cloneNode(true);
          modal.innerHTML = parakeetTempl.innerHTML;
          loadParakeetClient(modal, workerBaseUrl);
        })
        .catch(function(err) {
          console.log('Template error: ', err);
        });
    } else {
      modal.innerHTML = document.querySelector(templateSelector).innerHTML;
      document.querySelector(templateSelector).remove();
      loadParakeetClient(modal, workerBaseUrl);
    }
  }
}

customElements.define('client-parakeet-service', ParakeetLocalService);

// seconds of nothing after a sentence end before Parakeet's decoder is reset (#671)
const BLANK_RESET_SECONDS = 2;

function loadParakeetClient(modal, workerBaseUrl) {

  console.log("loading parakeet local client");

  // Distinct IDs from the Whisper tab: both templates live in the modal DOM
  // at the same time, so shared IDs would collide.
  const fileUploadBtn = document.getElementById("parakeet-file-input");
  const mediaUrlInput = document.getElementById("parakeet-media");
  const formSubmitBtn = document.getElementById("parakeet-form-submit-btn");
  const deviceLabel = document.getElementById("parakeet-device");
  const modelSelect = document.getElementById("parakeet-model");
  const videoPlayer = document.getElementById("hyperplayer");

  // the Model select (#785), filled here so the template carries no model
  // names; transcribe-prefs.js remembers the choice across sessions
  if (modelSelect !== null) {
    modelSelect.innerHTML = "";
    PARAKEET_MODELS.forEach((m) => {
      const option = document.createElement("option");
      option.value = m.value;
      option.textContent = m.label;
      modelSelect.appendChild(option);
    });
    modelSelect.value = PARAKEET_MODELS[0].value;
  }
  const chosenModel = () => PARAKEET_MODELS.find((m) => modelSelect !== null && m.value === modelSelect.value) || PARAKEET_MODELS[0];

  if (workerBaseUrl === undefined || workerBaseUrl === null) {
    workerBaseUrl = "./";
  }

  const parakeetWorkerPath = workerBaseUrl + "js/parakeet.worker.js?v=1.3.46";

  // On Chrome (Chromium) Parakeet runs fp16 on the GPU (WebGPU) – fast, and the
  // default. Firefox's WebGPU underperforms here and Safari's can exhaust memory
  // on the large encoder (it has locked up the whole machine), so both default
  // to the smaller int8 encoder on the CPU – it works but is several times
  // slower than the audio. We still let the user opt in to the GPU path with a
  // proportional warning, so capable setups can use it and we can gather
  // real-world cases for browser makers. `gpuOptIn` is read at submit time.
  const ua = navigator.userAgent;
  const isFirefox = /firefox/i.test(ua);
  const isSafari = /safari/i.test(ua) && !/chrome|chromium|crios|edg|opr|android|fxios/i.test(ua);
  let gpuOptIn = null;
  if (isFirefox || isSafari) {
    const form = modal.querySelector("form");
    if (form !== null) {
      const browser = isSafari ? "Safari" : "Firefox";
      const note = document.createElement("div");
      note.setAttribute("role", "alert");
      note.style.cssText = "background:#fff7e0; border-left:4px solid #f0a800; border-radius:4px; padding:8px 12px; margin-bottom:12px; font-size:85%;";

      const intro = document.createElement("div");
      // Honest about the int8 accuracy limitation too (#388): quantization can
      // push soft boundary speech below the decoder's blank threshold, so the
      // words vanish while the output still looks complete.
      intro.textContent = `${browser}: Parakeet runs on the CPU here – much slower than the audio length, and softly-spoken words at the very start or end of a recording may be missed. Chrome is recommended for GPU acceleration and better accuracy.`;
      note.appendChild(intro);

      const optLabel = document.createElement("label");
      optLabel.style.cssText = "display:flex; align-items:center; gap:6px; margin-top:8px; cursor:pointer;";
      gpuOptIn = document.createElement("input");
      gpuOptIn.type = "checkbox";
      gpuOptIn.id = "parakeet-gpu-optin";
      optLabel.appendChild(gpuOptIn);
      optLabel.appendChild(document.createTextNode("Try GPU acceleration (experimental)"));
      note.appendChild(optLabel);

      const warn = document.createElement("div");
      warn.style.cssText = "display:none; margin-top:6px; font-weight:600; color:#9a3412;";
      // Proportional to the failure mode: Safari can take the whole OS down;
      // Firefox stays contained (errors / poor performance).
      warn.textContent = isSafari
        ? "⚠️ On Safari this can use enough memory to freeze your entire computer – you may lose unsaved work in other apps. Save everything first. Enabling it helps us report real-world cases to browser makers."
        : "⚠️ Firefox's WebGPU is experimental here and may error or run poorly (it should not crash your OS). Enabling it helps us report real-world cases to browser makers.";
      note.appendChild(warn);

      gpuOptIn.addEventListener("change", () => {
        warn.style.display = gpuOptIn.checked ? "block" : "none";
      });

      form.prepend(note);
    }
  }

  // The worker is created on demand and RETIRED when idle (#550). Wasm
  // linear memory never shrinks once grown: after one transcription the ort
  // heap (hundreds of MB to GB-class) stays resident in a live worker even
  // with its sessions released (#463's first tier) — Safari's memory
  // watchdog was reloading tabs left overnight over it. Ten idle minutes
  // after a request settles, the worker is terminated outright; the models
  // stay in Cache Storage, so the next transcription pays a few seconds of
  // session rebuild, not a re-download. (The test override keeps the tier
  // waitable in e2e.)
  let webWorker = null;
  let workerIdleTimer = null;
  const WORKER_IDLE_TERMINATE_MS = window.PARAKEET_WORKER_IDLE_MS || 10 * 60 * 1000;

  function scheduleWorkerRetirement() {
    clearTimeout(workerIdleTimer);
    workerIdleTimer = setTimeout(() => {
      if (webWorker === null) return;
      webWorker.terminate();
      webWorker = null;
      console.log("Parakeet: idle worker retired — wasm memory returned; the next transcription rebuilds sessions from the model cache");
    }, WORKER_IDLE_TERMINATE_MS);
  }

  // the button is a styled <label>, so "disabled" is the btn-disabled class
  // (pointer-events: none) plus a guard in the handler
  function updateSubmitState() {
    const hasFile = fileUploadBtn.files.length > 0;
    const hasUrl = mediaUrlInput !== null && mediaUrlInput.value.trim() !== "";
    const ready = hasFile || hasUrl;
    formSubmitBtn.classList.toggle("btn-disabled", !ready);
    formSubmitBtn.setAttribute("aria-disabled", String(!ready));
  }
  fileUploadBtn.addEventListener("change", updateSubmitState);
  if (mediaUrlInput !== null) {
    mediaUrlInput.addEventListener("input", updateSubmitState);
  }
  updateSubmitState();

  formSubmitBtn.addEventListener("click", async () => {
    if (formSubmitBtn.classList.contains("btn-disabled")) {
      return;
    }
    await handleFormSubmission();
  });

  function createWorker() {
    const worker = new Worker(parakeetWorkerPath, { type: "module" });

    worker.onmessage = (event) => {
      const data = event.data;
      switch (data.type) {
        case "progress": {
          // data.kind ("GPU"/"CPU") names the model build so it's clear which one
          // is downloading – and obvious if both ever download in one session.
          const model = data.kind ? `${data.kind} model` : "model";
          if (data.phase === "transcribe" && data.detail && progressTracker !== null) {
            // within-window progress (#676): the tracker turns the worker's
            // facts into a percentage, and the clock below keeps it moving
            // while the encoder's opaque call runs
            progressTracker.on(data.detail);
            transcribeProgressMessage();
            // one line per window start and end (not per decoder frame), so a
            // percentage that misbehaves can be read against the facts
            if (data.detail.stage !== "decode") {
              const d = data.detail;
              console.log(`%s progress: window %d/%d %s%s → %d%%`, "Parakeet", d.window + 1, d.windows, d.stage,
                d.stage === "done" ? "" : ` (${Math.round(d.seconds)}s of audio)`, progressTracker.percent());
            }
            break;
          }
          updateLoadingMessage(data.phase === "download"
            ? `Downloading ${model}… ${data.progress}%`
            : data.phase === "prepare"
              ? `Preparing ${model}…`
              : data.progress === null
                ? "Transcribing…"
                : `Transcribing… ${data.progress}%`);
          break;
        }
        case "device":
          console.log(`Parakeet running on ${data.device} (${data.dtype})`);
          lastDeviceLabel = data.device === "webgpu" ? "GPU (WebGPU)" : "CPU";
          progressDevice = data.device;
          progressTracker = newProgressTracker();
          if (deviceLabel !== null) {
            // The CPU caveat also reaches Chromium users who silently fell
            // back from WebGPU and never saw the Safari/Firefox note (#388).
            deviceLabel.textContent = data.device === "webgpu"
              ? `Running on ${lastDeviceLabel}`
              : `Running on ${lastDeviceLabel} – soft speech at the very start/end may be missed`;
          }
          break;
        case "result":
          scheduleWorkerRetirement();
          finishProgress(() => {
            if (typeof setTranscriptBusy === "function") {
              setTranscriptBusy(false);
            }
            if (pendingInfo !== null && typeof setTranscriptionInfo === "function") {
              setTranscriptionInfo({ ...pendingInfo, device: lastDeviceLabel, seconds: data.output.seconds });
            }
            // the player is another project's when this finishes off screen (#715)
            if (!(typeof window.hyperaudioTranscriptionInBackground === 'function' && window.hyperaudioTranscriptionInBackground())) {
              videoPlayer.currentTime = 0;
            }
            parakeetParseData(data.output);
          });
          break;
        case "fallback":
          // The worker is switching engines, not dying (#529): keep the
          // loader and the in-progress row; the CPU pass's own progress
          // messages follow this line.
          updateLoadingMessage(data.message || "Retrying on the CPU…");
          break;
        case "error":
          scheduleWorkerRetirement();
          handleError(data.message, data.stage);
          break;
      }
    };

    worker.onerror = (event) => {
      // Since #529 the worker suppresses its own uncaught runtime errors
      // (the request's try/catch reports real failures via {type:"error"}),
      // so reaching here means the worker script itself failed to load or
      // parse — that IS fatal, nothing will ever answer. The browser killing
      // the worker under memory pressure arrives the same way, with no
      // message, which is why the fallback text below names memory rather
      // than blaming the script (#627).
      console.error(event);
      // a worker that can't even load has nothing worth keeping — retire it
      // now so a retry starts from a fresh one
      worker.terminate();
      if (webWorker === worker) webWorker = null;
      handleError(event.message || "Transcription stopped unexpectedly. With long media this is usually the browser running out of memory — try a shorter file, or a local copy rather than a URL.");
    };

    return worker;
  }

  let progressTicker = null;
  let progressStart = 0;
  let progressMessage = "";
  let lastDeviceLabel = "";
  let pendingInfo = null;
  let progressTracker = null;    // #676: a percentage that moves within a window
  let progressDevice = null;     // from the worker's last "device" message

  // one tracker per transcription: it never falls, so a run that reuses the
  // worker's loaded model (no fresh "device" message) must not inherit the
  // last run's 100% — and every run counts the same way from the start
  function newProgressTracker() {
    if (typeof window.createTranscriptionProgressTracker !== "function") return null;
    return window.createTranscriptionProgressTracker({ device: progressDevice });
  }

  function transcribeProgressMessage() {
    if (progressTracker === null) return;
    updateLoadingMessage(`Transcribing… ${progressTracker.percent()}%`);
  }

  function startProgressClock() {
    progressStart = Date.now();
    progressTracker = newProgressTracker();
    clearInterval(progressTicker);
    // a tenth-of-a-second tick: the encoder's share of the bar is counted up by
    // elapsed time, and the shown value catches up with a leaping target a
    // point per tick
    progressTicker = setInterval(() => {
      if (progressTracker !== null && /^Transcribing…/.test(progressMessage)) transcribeProgressMessage();
      else renderLoadingMessage();
    }, 100);
  }

  function stopProgressClock() {
    clearInterval(progressTicker);
    progressTicker = null;
  }

  // The shown percentage trails the facts, so a fast finish would close the
  // loader on 70-odd: count the rest of the way to 100 in well under a
  // second, let 100 be seen, and only then hand over to `then`. Paced by the
  // clock, not by ticks, and not at all in a hidden tab: its timers fire once
  // a second, or once a minute after five minutes, and a tick-based count
  // left the transcript unrendered for over a minute.
  function finishProgress(then) {
    stopProgressClock();
    const from = progressTracker !== null && /^Transcribing…/.test(progressMessage) ? progressTracker.inspect().shown : 100;
    if (from >= 100 || document.hidden) { then(); return; }
    const remaining = 100 - from;
    const stepMs = Math.min(100, Math.floor(600 / remaining));
    const started = Date.now();
    const finisher = setInterval(() => {
      const shown = Math.min(100, from + Math.floor((Date.now() - started) / stepMs));
      updateLoadingMessage(`Transcribing… ${shown}%`);
      if (shown === 100) { clearInterval(finisher); setTimeout(then, 250); }
    }, stepMs);
  }

  function formatElapsed(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  function renderLoadingMessage() {
    const msg = document.querySelector("#hypertranscript .transcribing-msg");
    if (msg !== null) {
      msg.innerHTML = `${progressMessage} <span style="font-size:80%; opacity:0.55">(${formatElapsed(Date.now() - progressStart)})</span>`;
    }
  }

  function updateLoadingMessage(message) {
    progressMessage = message;
    renderLoadingMessage();
  }

  // The advice fits the step that failed (#763): the media could not be read
  // (the message says why), the model could not be downloaded (the files come
  // from Hugging Face on first use, and a refused or lost connection shows as
  // "Failed to fetch"), the model could not be loaded, or inference failed.
  function adviceFor(stage, message) {
    if (stage === "media") return "";
    if (stage === "load") {
      return /fetch|network|HTTP|status/i.test(String(message || ""))
        ? "The model could not be downloaded. Check your connection and try again later."
        : "The model could not be loaded. Reload the page and try again.";
    }
    return "Reload the page and try again.";
  }

  function handleError(message, stage) {
    stopProgressClock();
    if (typeof setTranscriptBusy === "function") {
      setTranscriptBusy(false);
    }
    console.error("Parakeet error: " + message);
    const advice = adviceFor(stage, message);
    const detail = message ? '<br/><span style="font-size:80%; opacity:0.7">'+String(message).slice(0, 200)+'</span>' : '';
    showTranscriptNotice(
      '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>Transcription failed.'+(advice ? '<br/>' + advice : '')+detail+'</center></div>');
  }

  async function handleFormSubmission() {

    // a request is starting: hold retirement, and stand the worker up if the
    // previous one was retired (#550)
    clearTimeout(workerIdleTimer);
    if (webWorker === null) webWorker = createWorker();

    // If the user is in caption mode, switch back to transcript view so the
    // transcribing loader is visible and the result lands in the right place.
    document.querySelector('#transcript-editor-btn')?.click();

    const file = fileUploadBtn.files[0];
    const mediaUrl = mediaUrlInput !== null ? mediaUrlInput.value.trim() : "";
    // a file takes precedence; otherwise transcribe from the URL (HLS or plain)
    const useUrl = (file === undefined || file === null) && mediaUrl !== "";

    const model = chosenModel();
    pendingInfo = {
      service: "Parakeet (local, in your browser)",
      model: `${model.label} (multilingual)`,
      language: "Auto-detect",
      // what was really run (#668): the ONNX export the worker downloads, and
      // the runtime it runs under; a unit test holds these to the worker's
      modelId: model.modelId,
      parameters: {},
      runtime: "onnxruntime-web",
      engineVersion: "1.26.0",
    };

    if (!useUrl) {
      videoPlayer.src = URL.createObjectURL(file);
    } else {
      // The URL goes on the player NOW, before the busy signal, as the cloud
      // engines do (#643): the save module captures what is being transcribed
      // at that signal. With the previous project's media still on the player,
      // the new project was named after that media and saved with its file.
      // readAudioFromUrl attaches the URL properly once it is classified
      // (plain or HLS), so playback and click-to-seek are as before.
      if (typeof detachHls === "function") detachHls(videoPlayer);
      videoPlayer.src = mediaUrl;
    }

    if (document.querySelector('#transcribe-dialog') !== null){
      document.querySelector('#transcribe-dialog').close();
    }

    const loadingMessageContainer = document.getElementById("hypertranscript");
    // the URL is read before the model is touched, and a host that is slow or
    // dead holds this step (#762): the notice says which step it is
    const firstStep = useUrl ? "Reading the media from the URL…" : "Preparing model…";
    showTranscriptNotice('<div class="vertically-centre"><center class="transcribing-msg">' + firstStep + '</center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>');
    if (typeof setTranscriptBusy === "function") {
      setTranscriptBusy(true);
    }
    progressMessage = firstStep;
    startProgressClock();

    let audio;
    try {
      // shared 16 kHz mono decode helper (js/audio-source.js, #359); for a URL
      // the bytes come from hls.js / fetch first (js/hls-source.js, #358)
      audio = useUrl
        ? await readAudioFromUrl(mediaUrl, videoPlayer, (p) => updateLoadingMessage(`Downloading audio… ${p}%`))
        : await decodeToMono16k(file);
    } catch (e) {
      console.error(e);
      handleError(useUrl ? (e.message || "Could not load audio from the URL.") : "Could not decode the media file.", "media");
      return;
    }

    // forceGpu: the user explicitly opted in to the GPU path on a browser we'd
    // otherwise keep on the CPU (only present on Firefox/Safari).
    const forceGpu = gpuOptIn !== null && gpuOptIn.checked;

    // transfer the buffer rather than copying it
    // After a sentence-final word the decoder can stay stuck emitting nothing,
    // and drop a whole stretch of quieter speech that follows (#671). So it is
    // reset to its starting state after 2 s of nothing following a sentence
    // end. Tested on the recording that showed it: 2 s recovers the lost
    // stretch with no side effects, 1 s starts transcribing faint background
    // speech. localStorage.parakeetBlankReset overrides the 2 s, for testing
    // ("0" turns the reset off). The full fix, short windows each decoded
    // from a fresh state as FluidAudio does, is its own piece of work.
    let blankResetSeconds = BLANK_RESET_SECONDS;
    try {
      const override = localStorage.getItem("parakeetBlankReset");
      if (override !== null) blankResetSeconds = Number(override) || 0;
    } catch (e) { /* no storage */ }
    if (blankResetSeconds !== BLANK_RESET_SECONDS) console.log(`Parakeet: decoder reset after ${blankResetSeconds}s of blanks following a sentence end (overridden; default ${BLANK_RESET_SECONDS}s)`);
    webWorker.postMessage({ type: "INFERENCE_REQUEST", audio, forceGpu, blankResetSeconds, model: model.value }, [audio.buffer]);
  }
}

// The transcript on the page from the worker's { words: [{ word, start, end }] }:
// the same converter as the endpoint, js/converters/parakeet.js (#751). Local
// transcription has no diarization and no VTT language label.
function parakeetParseData(json) {
  const converted = window.HyperaudioConverters.parakeet(json);
  const hyperTranscript = jsonToHTML({ words: converted.words, paragraphs: converted.paragraphs });

  // finished while another project is open: it goes to Recents, and the screen stays where it is (#715)
  if (typeof window.hyperaudioKeepTranscription === 'function' && window.hyperaudioKeepTranscription({ html: hyperTranscript })) {
    return;
  }
  document.querySelector("#hypertranscript").innerHTML = hyperTranscript;
  document.querySelector('#download-html').setAttribute('href', 'data:text/html,' + encodeURIComponent(hyperTranscript));

  const initEvent = new CustomEvent('hyperaudioInit');
  document.dispatchEvent(initEvent);
  const capEvent = new CustomEvent('hyperaudioGenerateCaptionsFromTranscript');
  document.dispatchEvent(capEvent);
}

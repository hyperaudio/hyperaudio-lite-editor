/**
 * hyperaudio-lite-editor-whisper.js
 * (C) The Hyperaudio Project
 * @version 1.3.44 — last changed in release 1.3.44
 * @license AGPL-3.0-only
 */

// Where this engine keeps its downloaded models (#615), so Settings can size
// and remove them without knowing any engine. 'transformers-cache' is the
// Cache API name transformers.js (4.2.0, whisper.worker.js) stores under;
// each model's files sit under its Hugging Face repo path, which `label`
// turns into the name the Transcribe modal uses (size, and English-only or
// multilingual) so every model can be removed on its own. Null marks an
// entry as ancillary — counted in the total, not listed, and dropped with
// the last model.
(window.HyperaudioModelStores = window.HyperaudioModelStores || []).push({
  engine: 'Whisper',
  cacheName: 'transformers-cache',
  label(url) {
    // <host>/<org>/<repo>/resolve/... — the repo names the model. Sizes are
    // read from the repo name so older repos (Xenova/whisper-tiny.en, from
    // before the June 2026 lineup) label the same way as today's.
    const repo = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/resolve\//.exec(url);
    if (repo === null) return null;   // the ONNX runtime, cached alongside: not a model
    const m = /whisper-(tiny|base|small|medium|large[a-z0-9-]*)(\.en)?(?:_|$)/.exec(repo[1].split('/')[1] + '_');
    if (m === null) return 'Whisper · ' + repo[1];
    const size = /turbo/.test(m[1]) ? 'turbo' : m[1];
    return 'Whisper ' + size + (m[2] ? ' · English' : ' · multilingual');
  },
});

class WhisperService extends HTMLElement {

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
            // When the page is loaded convert it to text
            return response.text()
        })
        .then(function(html) {
          // Initialize the DOM parser
          let parser = new DOMParser();

          // Parse the text
          template = parser.parseFromString(html, "text/html");
          let whisperTempl = template.querySelector('#whisper-client-template').cloneNode(true);
          modal.innerHTML = whisperTempl.innerHTML;
          loadWhisperClient(modal, workerBaseUrl);
        })
        .catch(function(err) {
          console.log('Template error: ', err);
        });
    } else {
      modal.innerHTML = document.querySelector(templateSelector).innerHTML;
      document.querySelector(templateSelector).remove();
      loadWhisperClient(modal, workerBaseUrl);
    }
  }
}

customElements.define('client-whisper-service', WhisperService);

function loadWhisperClient(modal, workerBaseUrl) {

  console.log("loading whisper client");

  const fileUploadBtn = document.getElementById("file-input");
  const mediaUrlInput = document.getElementById("media");
  const formSubmitBtn = document.getElementById("form-submit-btn");
  const modelNameSelectionInput = document.getElementById("model-name-input");
  const languageSelectionInput = document.getElementById("whisper-language");
  const videoPlayer = document.getElementById("hyperplayer");


  if (workerBaseUrl === undefined || workerBaseUrl === null) {
    workerBaseUrl = "./";
  }

  const whisperWorkerPath = workerBaseUrl + "js/whisper.worker.js?v=1.3.44";

  // Turbo is WebGPU-only (#461): neither of its quantised variants loads on
  // the WASM runtime, so without a usable GPU the worker refuses it. Grey the
  // option out up front rather than let users pick a model that can't run.
  // Mirrors the worker's device choice, where Firefox prefers WASM over its
  // slower WebGPU.
  // Keep the probe's answer and apply it again whenever Settings ▸
  // Experimental features changes: an option marked experimental
  // (js/experimental-features.js) may be out of the menu when the probe
  // answers and put back later.
  let gpuUsable = null;
  const limitToGpu = () => {
    if (gpuUsable === false && modelNameSelectionInput !== null) {
      const turboOption = modelNameSelectionInput.querySelector('option[value="turbo"]');
      if (turboOption !== null) {
        turboOption.disabled = true;
        turboOption.textContent = "Whisper (Large v3 Turbo) – needs a GPU (unavailable in this browser)";
      }
      // a persisted preference may already have restored turbo — drop back to
      // the default model rather than submit with a disabled option selected
      if (modelNameSelectionInput.value === "turbo") {
        modelNameSelectionInput.value = "base";
      }
    }
  };
  document.addEventListener("hyperaudio:experimental", limitToGpu);
  (async () => {
    try {
      gpuUsable = !/firefox/i.test(navigator.userAgent)
        && navigator.gpu !== undefined
        && (await navigator.gpu.requestAdapter()) !== null;
    } catch (e) {
      gpuUsable = false;   // treat as no GPU
    }
    limitToGpu();
  })();

  // Firefox runs Whisper on the CPU (its WebGPU is still much slower than
  // its CPU path) – workable for the smaller models, but the larger ones may
  // be slow or fail. Say so up front rather than letting users find out.
  if (/firefox/i.test(navigator.userAgent)) {
    const form = modal.querySelector("form");
    if (form !== null) {
      const note = document.createElement("div");
      note.setAttribute("role", "alert");
      note.style.cssText = "background:#fff7e0; border-left:4px solid #f0a800; border-radius:4px; padding:8px 12px; margin-bottom:12px; font-size:85%;";
      note.textContent = "Firefox: we recommend the Tiny or Base models – larger models may be slow or may not work.";
      form.prepend(note);
    }
  }

  // The worker is created on demand and RETIRED when idle (#552, the #550
  // pattern ported from the Parakeet client): wasm linear memory never
  // shrinks once grown, so a live worker pins its ort heap for the tab's
  // lifetime. Ten idle minutes after a request settles it is terminated;
  // downloaded models stay in the browser cache, so the next transcription
  // pays session rebuild, not re-download.
  let webWorker = null;
  let workerIdleTimer = null;
  const WORKER_IDLE_TERMINATE_MS = window.WHISPER_WORKER_IDLE_MS || 10 * 60 * 1000;

  function scheduleWorkerRetirement() {
    clearTimeout(workerIdleTimer);
    workerIdleTimer = setTimeout(() => {
      if (webWorker === null) return;
      webWorker.terminate();
      webWorker = null;
      console.log("Whisper: idle worker retired — wasm memory returned; the next transcription reloads the model");
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

  formSubmitBtn.addEventListener("click", async (event2) => {
    if (formSubmitBtn.classList.contains("btn-disabled")) {
      return;
    }
    await handleFormSubmission();
  });

  function createWorker() {
    const worker = new Worker(whisperWorkerPath, { type: "module" });

    worker.onmessage = (event) => {
      const data = event.data;
      switch (data.type) {
        case "progress":
          if (data.phase === "transcribe" && data.detail && progressTracker !== null) {
            // within-window progress (#676): the tracker turns the worker's
            // facts into a percentage, and the clock below keeps it moving
            // while a window's single call runs
            progressTracker.on(data.detail);
            transcribeProgressMessage();
            // one line per window start and end (not per decoder frame), so a
            // percentage that misbehaves can be read against the facts
            if (data.detail.stage !== "decode") {
              const d = data.detail;
              console.log(`%s progress: window %d/%d %s%s → %d%%`, "Whisper", d.window + 1, d.windows, d.stage,
                d.stage === "done" ? "" : ` (${Math.round(d.seconds)}s of audio)`, progressTracker.percent());
            }
            break;
          }
          updateLoadingMessage(data.phase === "download"
            ? `Downloading model… ${data.progress}%`
            : data.phase === "prepare"
              ? "Preparing model…"
              : data.progress === null
                ? "Transcribing…"
                : `Transcribing… ${data.progress}%`);
          break;
        case "device":
          console.log(`Whisper running on ${data.device} (${data.dtype})`);
          lastDeviceLabel = data.device === "webgpu" ? "GPU (WebGPU)" : "CPU";
          progressDevice = data.device;
          progressTracker = newProgressTracker();
          break;
        case "result":
          scheduleWorkerRetirement();
          finishProgress(() => {
            if (pendingInfo !== null && typeof setTranscriptionInfo === "function") {
              setTranscriptionInfo({ ...pendingInfo, device: lastDeviceLabel, seconds: data.output.seconds });
            }
            handleInferenceDone(data);
          });
          break;
        case "error":
          scheduleWorkerRetirement();
          handleError(data.message, data.stage);
          break;
      }
    };

    worker.onerror = (event) => {
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

  // the worker only hears from a window when it starts and when it ends, so
  // a ticking clock carries the percentage in between — a tenth of a second,
  // the pace at which the shown value catches up with a target that leapt
  function startProgressClock() {
    progressStart = Date.now();
    progressTracker = newProgressTracker();
    clearInterval(progressTicker);
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
        : "The model could not be loaded. Try a smaller model or reload the page.";
    }
    return "Try a smaller model or reload the page.";
  }

  function handleError(message, stage) {
    stopProgressClock();
    if (typeof setTranscriptBusy === "function") {
      setTranscriptBusy(false);
    }
    console.error("Whisper error: " + message);
    const advice = adviceFor(stage, message);
    const detail = message ? '<br/><span style="font-size:80%; opacity:0.7">'+String(message).slice(0, 200)+'</span>' : '';
    showTranscriptNotice(
      '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>Transcription failed.'+(advice ? '<br/>' + advice : '')+detail+'</center></div>');
  }

  function handleInferenceDone(results) {

    if (typeof setTranscriptBusy === "function") {
      setTranscriptBusy(false);
    }

    // the pipeline's chunks as the transcript: js/converters/whisper.js (#751)
    const converted = window.HyperaudioConverters.whisper(results.output);
    const html = jsonToHTML({ words: converted.words, paragraphs: converted.paragraphs });
    // finished while another project is open: it goes to Recents, and the screen stays where it is (#715)
    if (typeof window.hyperaudioKeepTranscription === 'function' && window.hyperaudioKeepTranscription({ html })) {
      return;
    }
    videoPlayer.currentTime = 0;
    const resultsContainer = document.getElementById("hypertranscript");
    resultsContainer.innerHTML = html;

    const initEvent = new CustomEvent('hyperaudioInit');
    document.dispatchEvent(initEvent);
    const capEvent = new CustomEvent('hyperaudioGenerateCaptionsFromTranscript');
    document.dispatchEvent(capEvent);
  }

  async function handleFormSubmission() {

    // a request is starting: hold retirement, and stand the worker up if the
    // previous one was retired (#552)
    clearTimeout(workerIdleTimer);
    if (webWorker === null) webWorker = createWorker();

    // If the user is in caption mode, switch back to transcript view so the
    // transcribing loader is visible and the result lands in the right place.
    // #transcript-editor-btn's handler no-ops when already in transcript mode.
    document.querySelector('#transcript-editor-btn')?.click();

    let size = modelNameSelectionInput.value;
    // a persisted "turbo" preference can be restored after the GPU probe above
    // disabled the option (the probe is async, the restore races it) — fall
    // back to the default model instead of submitting one the worker refuses
    if (modelNameSelectionInput.selectedOptions[0]?.disabled) {
      size = "base";
      modelNameSelectionInput.value = "base";
    }
    const language = languageSelectionInput !== null ? languageSelectionInput.value : "";
    // English gets the slightly more accurate English-only variants; any
    // other language (or auto-detect) needs the multilingual ones. Turbo
    // only exists as a multilingual model.
    const WHISPER_MODELS = {
      tiny:  { en: "onnx-community/whisper-tiny.en_timestamped",  multi: "onnx-community/whisper-tiny_timestamped" },
      base:  { en: "onnx-community/whisper-base.en_timestamped",  multi: "onnx-community/whisper-base_timestamped" },
      small: { en: "onnx-community/whisper-small.en_timestamped", multi: "onnx-community/whisper-small_timestamped" },
      turbo: { en: "onnx-community/whisper-large-v3-turbo_timestamped", multi: "onnx-community/whisper-large-v3-turbo_timestamped" },
    };
    const model_name = (WHISPER_MODELS[size] || WHISPER_MODELS.base)[language === "en" ? "en" : "multi"];
    const file = fileUploadBtn.files[0];
    const mediaUrl = mediaUrlInput !== null ? mediaUrlInput.value.trim() : "";
    // a file takes precedence; otherwise transcribe from the URL (HLS or plain)
    const useUrl = (file === undefined || file === null) && mediaUrl !== "";

    const SIZE_LABELS = { tiny: "Whisper Tiny", base: "Whisper Base", small: "Whisper Small", turbo: "Whisper Large v3 Turbo" };
    pendingInfo = {
      service: "Whisper (local, in your browser)",
      model: (SIZE_LABELS[size] || size) + (language === "en" && size !== "turbo" ? " (English)" : " (multilingual)"),
      language: languageSelectionInput !== null && languageSelectionInput.selectedOptions.length > 0
        ? languageSelectionInput.selectedOptions[0].textContent
        : "Auto-detect",
      languageCode: language,   // "" when auto-detecting
      // what was really run (#668). The runtime and its version are the
      // worker's import; a unit test holds the two together. "+pr1755" is
      // the patch the vendored build carries (#462, js/vendor/README.md).
      modelId: model_name,
      parameters: { model: model_name, language: language || 'auto', word_timestamps: true },
      runtime: 'transformers.js',
      engineVersion: '4.3.1+pr1755',
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

    // transfer the buffer rather than copying it - large files would otherwise
    // be structured-cloned in full
    webWorker.postMessage({
      type: "INFERENCE_REQUEST",
      audio,
      model_name,
      language
    }, [audio.buffer]);
  }
}

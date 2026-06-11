/**
 * hyperaudio-lite-editor-whisper.js
 * (C) The Hyperaudio Project
 * @version 0.6.7 — last changed in release 0.6.7
 * @license MIT
 */

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
  const formSubmitBtn = document.getElementById("form-submit-btn");
  const modelNameSelectionInput = document.getElementById("model-name-input");
  const videoPlayer = document.getElementById("hyperplayer");


  if (workerBaseUrl === undefined || workerBaseUrl === null) {
    workerBaseUrl = "./";
  }

  const whisperWorkerPath = workerBaseUrl + "js/whisper.worker.js?v=0.6.7";

  let webWorker = createWorker();

  formSubmitBtn.addEventListener("click", async (event2) => {
    await handleFormSubmission();
  });

  function createWorker() {
    const worker = new Worker(whisperWorkerPath, { type: "module" });

    worker.onmessage = (event) => {
      const data = event.data;
      switch (data.type) {
        case "progress":
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
          // a pathologically slow warm-up means this browser's WebGPU is not
          // worth using (e.g. extensive internal CPU fallback) – remember
          // that and use the plain CPU path next time. The flag expires so
          // the GPU gets re-probed as browser implementations improve.
          if (data.device === "webgpu" && data.warmupSeconds > SLOW_WEBGPU_WARMUP_S) {
            localStorage.setItem(AVOID_WEBGPU_KEY, JSON.stringify({ at: Date.now(), warmupSeconds: data.warmupSeconds }));
            console.warn(`WebGPU warm-up took ${data.warmupSeconds.toFixed(1)}s – future transcriptions in this browser will use the CPU instead (re-probed after ${AVOID_WEBGPU_DAYS} days)`);
          }
          break;
        case "result":
          stopProgressClock();
          handleInferenceDone(data);
          break;
        case "error":
          // a failed session creation poisons the WASM runtime for every
          // later attempt in that worker, so in-worker fallbacks can't be
          // trusted – throw the worker away and retry once in a fresh one
          // with the most compatible config (wasm + fp32)
          if (data.stage === "load" && lastSubmission !== null && lastSubmission.compatRetried === false) {
            lastSubmission.compatRetried = true;
            console.warn("Model failed to load – retrying in a fresh worker in compatibility mode (wasm/fp32)");
            webWorker.terminate();
            webWorker = createWorker();
            updateLoadingMessage("Retrying in compatibility mode…");
            submitToWorker(lastSubmission.file, lastSubmission.model_name, true);
            break;
          }
          handleError(data.message);
          break;
      }
    };

    worker.onerror = (event) => {
      console.error(event);
      handleError(event.message || "The transcription worker crashed.");
    };

    return worker;
  }

  let progressTicker = null;
  let progressStart = 0;
  let progressMessage = "";
  let lastSubmission = null;

  const AVOID_WEBGPU_KEY = "hyperaudio-whisper-avoid-webgpu";
  const SLOW_WEBGPU_WARMUP_S = 30;
  const AVOID_WEBGPU_DAYS = 30;

  function shouldAvoidWebGpu() {
    try {
      const stored = JSON.parse(localStorage.getItem(AVOID_WEBGPU_KEY));
      if (stored !== null && (Date.now() - stored.at) < AVOID_WEBGPU_DAYS * 24 * 60 * 60 * 1000) {
        return true;
      }
    } catch (e) { /* absent or malformed – treat as no preference */ }
    return false;
  }

  // progress messages only arrive when a whole window completes, so a ticking
  // clock is the liveness signal in between
  function startProgressClock() {
    progressStart = Date.now();
    clearInterval(progressTicker);
    progressTicker = setInterval(renderLoadingMessage, 1000);
  }

  function stopProgressClock() {
    clearInterval(progressTicker);
    progressTicker = null;
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
      msg.textContent = `${progressMessage} (${formatElapsed(Date.now() - progressStart)})`;
    }
  }

  function updateLoadingMessage(message) {
    progressMessage = message;
    renderLoadingMessage();
  }

  function handleError(message) {
    stopProgressClock();
    console.error("Whisper error: " + message);
    const detail = message ? '<br/><span style="font-size:80%; opacity:0.7">'+String(message).slice(0, 200)+'</span>' : '';
    document.getElementById("hypertranscript").innerHTML =
      '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>Transcription failed.<br/>Try a smaller model or reload the page.'+detail+'</center></div>';
  }

  function handleInferenceDone(results) {

    videoPlayer.currentTime = 0;

    let hypertranscript = "";
    let sentences = 0;
    let lastWord = "";

    results.output.chunks.forEach((word) => {

      // whisper marks word boundaries with a leading space on the text
      const text = word.text.trim();

      // ignore empty text and text with square brackets - usually contains things like [BLANK _AUDIO]
      if (text.length > 0 && text.indexOf("[") < 0  && text.indexOf("]") < 0) {
        let start = Math.floor(word.timestamp[0]*1000);
        let end = word.timestamp[1] ?? (word.timestamp[0] + 0.5);
        let duration = Math.max(0, Math.floor((end*1000)-1) - start);
        let wordCapitalised = false;

        if (Array.from(text)[0].toUpperCase() === Array.from(text)[0]){
          wordCapitalised = true;
        }

        if (wordCapitalised === true && lastWord.endsWith(".") ){
          sentences += 1;
        }

        lastWord = text;

        // new para every 5 sentences
        if (sentences % 5 === 0 && sentences !== 0) {
          hypertranscript += "\n  </p>\n  <p>\n";
          sentences = 0;
        }

        hypertranscript += `<span data-m='${start}' data-d='${duration}'>${text} </span>\n`;
      }
    });

    const resultsContainer = document.getElementById("hypertranscript");
    resultsContainer.innerHTML = "<article>\n <section>\n  <p>\n" + hypertranscript + "  </p>\n </section>\n</article>\n";

    const initEvent = new CustomEvent('hyperaudioInit');
    document.dispatchEvent(initEvent);
    const capEvent = new CustomEvent('hyperaudioGenerateCaptionsFromTranscript');
    document.dispatchEvent(capEvent);
  }

  async function handleFormSubmission() {

    // If the user is in caption mode, switch back to transcript view so the
    // transcribing loader is visible and the result lands in the right place.
    // #transcript-editor-btn is disabled in transcript mode, so this no-ops.
    document.querySelector('#transcript-editor-btn')?.click();

    const model_name = modelNameSelectionInput.value;
    const file = fileUploadBtn.files[0];

    videoPlayer.src = URL.createObjectURL(file);

    if (document.querySelector('#transcribe-dialog') !== null){
      document.querySelector('#transcribe-dialog').close();
    }

    const loadingMessageContainer = document.getElementById("hypertranscript");
    loadingMessageContainer.innerHTML = '<div class="vertically-centre"><center class="transcribing-msg">Preparing model…</center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
    progressMessage = "Preparing model…";
    startProgressClock();

    lastSubmission = { file, model_name, compatRetried: false };
    await submitToWorker(file, model_name, false);
  }

  async function submitToWorker(file, model_name, compat) {
    let audio;
    try {
      // the buffer is transferred away on each submission, so a retry has to
      // decode the file again
      audio = await readAudioFrom(file);
    } catch (e) {
      console.error(e);
      handleError("Could not decode the media file.");
      return;
    }

    // transfer the buffer rather than copying it - large files would otherwise
    // be structured-cloned in full
    webWorker.postMessage({
      type: "INFERENCE_REQUEST",
      audio,
      model_name,
      compat,
      avoid_webgpu: shouldAvoidWebGpu()
    }, [audio.buffer]);
  }

  async function readAudioFrom(file) {
    const sampling_rate = 16e3;
    const audioCTX = new AudioContext({ sampleRate: sampling_rate });
    try {
      const response = await file.arrayBuffer();
      const decoded = await audioCTX.decodeAudioData(response);
      return decoded.getChannelData(0);
    } finally {
      audioCTX.close();
    }
  }
}

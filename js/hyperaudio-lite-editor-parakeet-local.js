/**
 * hyperaudio-lite-editor-parakeet-local.js
 * (C) The Hyperaudio Project
 * @version 0.6.9 — last changed in release 0.6.9
 * @license MIT
 */

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

function loadParakeetClient(modal, workerBaseUrl) {

  console.log("loading parakeet local client");

  // Distinct IDs from the Whisper tab: both templates live in the modal DOM
  // at the same time, so shared IDs would collide.
  const fileUploadBtn = document.getElementById("parakeet-file-input");
  const formSubmitBtn = document.getElementById("parakeet-form-submit-btn");
  const deviceLabel = document.getElementById("parakeet-device");
  const videoPlayer = document.getElementById("hyperplayer");

  if (workerBaseUrl === undefined || workerBaseUrl === null) {
    workerBaseUrl = "./";
  }

  const parakeetWorkerPath = workerBaseUrl + "js/parakeet.worker.js?v=0.6.9";

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
      intro.textContent = `${browser}: Parakeet runs on the CPU here and is much slower than the audio length – Chrome is recommended for GPU acceleration.`;
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

  let webWorker = createWorker();

  // the button is a styled <label>, so "disabled" is the btn-disabled class
  // (pointer-events: none) plus a guard in the handler
  function updateSubmitState() {
    const ready = fileUploadBtn.files.length > 0;
    formSubmitBtn.classList.toggle("btn-disabled", !ready);
    formSubmitBtn.setAttribute("aria-disabled", String(!ready));
  }
  fileUploadBtn.addEventListener("change", updateSubmitState);
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
          if (deviceLabel !== null) {
            deviceLabel.textContent = `Running on ${lastDeviceLabel}`;
          }
          break;
        case "result":
          stopProgressClock();
          if (typeof setTranscriptBusy === "function") {
            setTranscriptBusy(false);
          }
          if (pendingInfo !== null && typeof setTranscriptionInfo === "function") {
            setTranscriptionInfo({ ...pendingInfo, device: lastDeviceLabel, seconds: data.output.seconds });
          }
          videoPlayer.currentTime = 0;
          parakeetParseData(data.output);
          break;
        case "error":
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
  let lastDeviceLabel = "";
  let pendingInfo = null;

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
      msg.innerHTML = `${progressMessage} <span style="font-size:80%; opacity:0.55">(${formatElapsed(Date.now() - progressStart)})</span>`;
    }
  }

  function updateLoadingMessage(message) {
    progressMessage = message;
    renderLoadingMessage();
  }

  function handleError(message) {
    stopProgressClock();
    if (typeof setTranscriptBusy === "function") {
      setTranscriptBusy(false);
    }
    console.error("Parakeet error: " + message);
    const detail = message ? '<br/><span style="font-size:80%; opacity:0.7">'+String(message).slice(0, 200)+'</span>' : '';
    document.getElementById("hypertranscript").innerHTML =
      '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>Transcription failed.<br/>Reload the page and try again.'+detail+'</center></div>';
  }

  async function handleFormSubmission() {

    // If the user is in caption mode, switch back to transcript view so the
    // transcribing loader is visible and the result lands in the right place.
    document.querySelector('#transcript-editor-btn')?.click();

    const file = fileUploadBtn.files[0];

    pendingInfo = {
      service: "Parakeet (local, in your browser)",
      model: "Parakeet TDT 0.6B v3 (multilingual)",
      language: "Auto-detect",
    };

    videoPlayer.src = URL.createObjectURL(file);

    if (document.querySelector('#transcribe-dialog') !== null){
      document.querySelector('#transcribe-dialog').close();
    }

    const loadingMessageContainer = document.getElementById("hypertranscript");
    loadingMessageContainer.innerHTML = '<div class="vertically-centre"><center class="transcribing-msg">Preparing model…</center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
    if (typeof setTranscriptBusy === "function") {
      setTranscriptBusy(true);
    }
    progressMessage = "Preparing model…";
    startProgressClock();

    let audio;
    try {
      audio = await readAudioFrom(file);
    } catch (e) {
      console.error(e);
      handleError("Could not decode the media file.");
      return;
    }

    // forceGpu: the user explicitly opted in to the GPU path on a browser we'd
    // otherwise keep on the CPU (only present on Firefox/Safari).
    const forceGpu = gpuOptIn !== null && gpuOptIn.checked;

    // transfer the buffer rather than copying it
    webWorker.postMessage({ type: "INFERENCE_REQUEST", audio, forceGpu }, [audio.buffer]);
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

// Build the editor's word-span HTML from { words: [{ word, start, end }] }.
// Adapted from the cloud Parakeet module (#307): local transcription has no
// diarization, so there are no speaker spans and no VTT language label.
function parakeetParseData(json) {

  const maxWordsInPara = 100;
  const significantGapInSeconds = 4.0;

  const wordData = json.words;
  const ms = (s) => Math.round(s * 1000);

  let hyperTranscript = "<article>\n <section>\n  <p>\n   ";
  let previousElementEnd = 0;
  let wordsInPara = 0;

  wordData.forEach((element, index) => {
    const currentWord = element.word;
    wordsInPara++;

    // split into a new paragraph on a significant silence gap after sentence-end
    if (previousElementEnd !== 0 && (element.start - previousElementEnd) > significantGapInSeconds || wordsInPara > maxWordsInPara) {
      const previousWord = wordData[index - 1].word;
      const previousWordLastChar = previousWord.charAt(previousWord.length - 1);
      if (previousWordLastChar === "." || previousWordLastChar === "?" || previousWordLastChar === "!") {
        hyperTranscript += "\n  </p>\n  <p>\n   ";
        wordsInPara = 0;
      }
    }

    hyperTranscript += `<span data-m='${ms(element.start)}' data-d='${ms(element.end - element.start)}'>${currentWord} </span>`;
    previousElementEnd = element.end;
  });

  hyperTranscript += "\n </p> \n </section>\n</article>\n ";
  hyperTranscript = hyperTranscript.replace(/<p>\s*<\/p>\s*/g, '');

  document.querySelector("#hypertranscript").innerHTML = hyperTranscript;
  document.querySelector('#download-html').setAttribute('href', 'data:text/html,' + encodeURIComponent(hyperTranscript));

  const initEvent = new CustomEvent('hyperaudioInit');
  document.dispatchEvent(initEvent);
  const capEvent = new CustomEvent('hyperaudioGenerateCaptionsFromTranscript');
  document.dispatchEvent(capEvent);
}

/**
 * hyperaudio-lite-editor-whisper.js
 * (C) The Hyperaudio Project
 * @version 0.6.26 — last changed in release 0.6.26
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
  const mediaUrlInput = document.getElementById("media");
  const formSubmitBtn = document.getElementById("form-submit-btn");
  const modelNameSelectionInput = document.getElementById("model-name-input");
  const languageSelectionInput = document.getElementById("whisper-language");
  const videoPlayer = document.getElementById("hyperplayer");


  if (workerBaseUrl === undefined || workerBaseUrl === null) {
    workerBaseUrl = "./";
  }

  const whisperWorkerPath = workerBaseUrl + "js/whisper.worker.js?v=0.6.7";

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

  let webWorker = createWorker();

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
          break;
        case "result":
          stopProgressClock();
          if (pendingInfo !== null && typeof setTranscriptionInfo === "function") {
            setTranscriptionInfo({ ...pendingInfo, device: lastDeviceLabel, seconds: data.output.seconds });
          }
          handleInferenceDone(data);
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
    console.error("Whisper error: " + message);
    const detail = message ? '<br/><span style="font-size:80%; opacity:0.7">'+String(message).slice(0, 200)+'</span>' : '';
    document.getElementById("hypertranscript").innerHTML =
      '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>Transcription failed.<br/>Try a smaller model or reload the page.'+detail+'</center></div>';
  }

  function handleInferenceDone(results) {

    if (typeof setTranscriptBusy === "function") {
      setTranscriptBusy(false);
    }
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

    const size = modelNameSelectionInput.value;
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
    };

    if (!useUrl) {
      videoPlayer.src = URL.createObjectURL(file);
    }
    // for a URL, playback is set up inside readAudioFromUrl once the source is
    // classified (HLS vs plain), so click-to-seek works after transcription.

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
      // shared 16 kHz mono decode helper (js/audio-source.js, #359); for a URL
      // the bytes come from hls.js / fetch first (js/hls-source.js, #358)
      audio = useUrl
        ? await readAudioFromUrl(mediaUrl, videoPlayer, (p) => updateLoadingMessage(`Downloading audio… ${p}%`))
        : await decodeToMono16k(file);
    } catch (e) {
      console.error(e);
      handleError(useUrl ? (e.message || "Could not load audio from the URL.") : "Could not decode the media file.");
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

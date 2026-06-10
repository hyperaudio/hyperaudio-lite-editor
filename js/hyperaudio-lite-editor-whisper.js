/*! (C) The Hyperaudio Project. MIT @license: en.wikipedia.org/wiki/MIT_License. */
/*! Version 0.1.0 (transformers.js v4 / WebGPU) */

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

  const whisperWorkerPath = workerBaseUrl + "js/whisper.worker.js";

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
            : `Transcribing… ${data.progress}%`);
          break;
        case "device":
          console.log(`Whisper running on ${data.device} (${data.dtype})`);
          break;
        case "result":
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

  function updateLoadingMessage(message) {
    const msg = document.querySelector("#hypertranscript .transcribing-msg");
    if (msg !== null) {
      msg.textContent = message;
    }
  }

  function handleError(message) {
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

      // ignore text with square brackets - usually contains things like [BLANK _AUDIO]
      if (word.text.indexOf("[") < 0  && word.text.indexOf("]") < 0) {
        let start = Math.floor(word.timestamp[0]*1000);
        let end = word.timestamp[1] ?? (word.timestamp[0] + 0.5);
        let duration = Math.max(0, Math.floor((end*1000)-1) - start);
        let wordCapitalised = false;

        if (Array.from(word.text)[0].toUpperCase() === Array.from(word.text)[0]){
          wordCapitalised = true;
        }

        if (wordCapitalised === true && lastWord.endsWith(".") ){
          sentences += 1;
        }

        lastWord = word.text;

        // new para every 5 sentences
        if (sentences % 5 === 0 && sentences !== 0) {
          hypertranscript += "\n  </p>\n  <p>\n";
          sentences = 0;
        }

        hypertranscript += `<span data-m='${start}' data-d='${duration}'>${word.text} </span>\n`;
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

    let audio;
    try {
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
      model_name
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

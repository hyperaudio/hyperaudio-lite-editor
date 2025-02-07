/*! (C) The Hyperaudio Project. MIT @license: en.wikipedia.org/wiki/MIT_License. */
/*! Version 0.0.6 (caption editor patch) */

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

    let results = [];
    worker.onmessage = (event) => {
      handleInferenceDone(event.data);
    };

    return worker;
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
        let duration = Math.floor((word.timestamp[1]*1000)-1) - start;
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

    const model_name = modelNameSelectionInput.value;
    const file = fileUploadBtn.files[0];
    const audio = await readAudioFrom(file);

    webWorker.postMessage({
      type: "INFERENCE_REQUEST",
      audio,
      model_name
    });

    videoPlayer.src = URL.createObjectURL(file);

    if (document.querySelector('#transcribe-dialog') !== null){
      document.querySelector('#transcribe-dialog').close();
    }

    const loadingMessageContainer = document.getElementById("hypertranscript");

    console.log("show spinner");
    console.log(loadingMessageContainer);

    loadingMessageContainer.innerHTML = '<div class="vertically-centre"><center class="transcribing-msg">Transcribing.... </center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
  }

  async function readAudioFrom(file) {
    const sampling_rate = 16e3;
    const audioCTX = new AudioContext({ sampleRate: sampling_rate });
    const response = await file.arrayBuffer();
    const decoded = await audioCTX.decodeAudioData(response);
    const audio = decoded.getChannelData(0);
    return audio;
  }
}
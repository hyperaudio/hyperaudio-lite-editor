/*! (C) The Hyperaudio Project. MIT @license: en.wikipedia.org/wiki/MIT_License. */
/*! Version 0.0.4 */


class WhisperService extends HTMLElement {

  constructor() {
    super();
  }

  connectedCallback() {

    let template = null;
    let modal = this;

    const templateUrl = "hyperaudio-client-whisper-template.html";

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
          loadWhisperClient(modal);
        })
        .catch(function(err) {  
          console.log('Template error: ', err);  
        });
    }
  }
}

customElements.define('client-whisper-service', WhisperService);

function loadWhisperClient(modal) {

  const fileUploadBtn = document.getElementById("file-input");
  const formSubmitBtn = document.getElementById("form-submit-btn");
  const modelNameSelectionInput = document.getElementById("model-name-input");
  const videoPlayer = document.getElementById("hyperplayer");
  const resultsContainer = document.getElementById("hypertranscript");
  const loadingMessageContainer = document.getElementById("hypertranscript");

  const whisperWorkerPath = "./js/whisper.worker.new.js";

  // leave the following three consts as is as they are shared by 
  // web.worker.js

  const MessageTypes = {
    DOWNLOADING: "DOWNLOADING",
    LOADING: "LOADING",
    RESULT: "RESULT",
    RESULT_PARTIAL: "RESULT_PARTIAL",
    INFERENCE_REQUEST: "INFERENCE_REQUEST",
    INFERENCE_DONE: "INFERENCE_DONE"
  };
  
  const LoadingStatus = {
    SUCCESS: "success",
    ERROR: "error",
    LOADING: "loading"
  };

  /*const ModelNames = {
    WHISPER_TINY_EN: "openai/whisper-tiny.en",
    WHISPER_TINY: "openai/whisper-tiny",
    WHISPER_BASE: "openai/whisper-base",
    WHISPER_BASE_EN: "openai/whisper-base.en",
    WHISPER_SMALL: "openai/whisper-small",
    WHISPER_SMALL_EN: "openai/whisper-small.en"
  };*/

  let webWorker = createWorker();
  console.log("webWorker");
  console.log(webWorker);


  formSubmitBtn.disabled = true;
  formSubmitBtn.addEventListener("click", async (event2) => {
    await handleFormSubmission();
  });

  function createWorker() {
    const worker = new Worker(whisperWorkerPath, { type: "module" });
    //const worker = new Worker("./js/whisper.worker.full.js");
    console.log("worker");
    console.log(worker);
    let results = [];
    worker.onmessage = (event2) => {
      /*const { type } = event2.data;
      if (type === MessageTypes.LOADING) {
        handleLoadingMessage(event2.data);
      }
      if (type === MessageTypes.DOWNLOADING) {
        loadingMessageContainer.innerHTML = '<div class="vertically-centre"><center>Downloading model...</center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
      }
      if (type === MessageTypes.RESULT) {
        handleResultMessage(event2.data);
        results = event2.data.results;
      }
      if (type === MessageTypes.RESULT_PARTIAL) {
        
      }
      if (type === MessageTypes.INFERENCE_DONE) {
        handleInferenceDone(results);
      }*/

      console.log("whisper wc");
      console.log(event2.data);
      handleInferenceDone(event2.data);
    };

    return worker;
  }

  function handleLoadingMessage(data) {
    const { status } = data;

    if (status === LoadingStatus.SUCCESS) {
      loadingMessageContainer.innerHTML = '<div class="vertically-centre"><center>Transcribing.... <span id="transcription-progress">0</span>%</center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
    }
    if (status === LoadingStatus.ERROR) {
      loadingMessageContainer.innerHTML = '<div class="vertically-centre"><center>Oops! Something went wrong. Please refresh the page and try again.</center><br/><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"></div>';
    }
    if (status === LoadingStatus.LOADING) {
      loadingMessageContainer.innerHTML = '<div class="vertically-centre"><center>Loading model into memory...</center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
    }
  }
  
  function handleResultMessage(data) {
    const { results, completedUntilTimestamp } = data;
    const totalDuration = videoPlayer.duration;
    const progress = completedUntilTimestamp / totalDuration * 100;
    document.querySelector("#transcription-progress").innerHTML = Math.round(progress);
  }

  function handleInferenceDone(results) {

    console.log(results);

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
        
        console.log(lastWord);
        console.log(word.text);
        console.log(wordCapitalised);
  
        if (wordCapitalised === true && lastWord.endsWith(".") ){
          sentences += 1;
        }
  
        lastWord = word.text;
  
        console.log(sentences);
        
        // new para every 5 sentences
        if (sentences % 5 === 0 && sentences !== 0) {
          hypertranscript += "\n  </p>\n  <p>\n";
          sentences = 0;
        }
  
        hypertranscript += `<span data-m='${start}' data-d='${duration}'>${word.text} </span>\n`;
      }
    
      //console.log(hypertranscript);
    });
    resultsContainer.innerHTML = "<article>\n <section>\n  <p>\n" + hypertranscript + "  </p>\n </section>\n</article>\n";

    const initEvent = new CustomEvent('hyperaudioInit');
    document.dispatchEvent(initEvent);
    const capEvent = new CustomEvent('hyperaudioGenerateCaptionsFromTranscript');
    document.dispatchEvent(capEvent);
  }

  async function handleFormSubmission() {

    console.log("handleFormSubmission()");

    /*if (!isFileUploaded() || !isModelNameSelected()) {
      return;
    }*/
    
    const model_name = `Xenova/${modelNameSelectionInput.value}`;
    const file = fileUploadBtn.files[0];
    const audio = await readAudioFrom(file);

    console.log("about to postMessage....");


    webWorker.postMessage({
      type: MessageTypes.INFERENCE_REQUEST,
      audio,
      model_name
    });

    console.log("web worker");
    console.log(webWorker);
    videoPlayer.src = URL.createObjectURL(file);

    loadingMessageContainer.innerHTML = '<div class="vertically-centre"><center>Transcribing.... </center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
  }

  async function readAudioFrom(file) {
    const sampling_rate = 16e3;
    const audioCTX = new AudioContext({ sampleRate: sampling_rate });
    const response = await file.arrayBuffer();
    const decoded = await audioCTX.decodeAudioData(response);
    const audio = decoded.getChannelData(0);
    return audio;
  }

  function isFileUploaded() {
    if (fileUploadBtn.files.length === 0) {
      return false;
    }
    return true;
  }

  function isModelNameSelected() {
    const selectedValue = modelNameSelectionInput.value;
    if (modelNameSelectionInput.value === "") {
      return false;
    }
    const modelName = `Xenova/${selectedValue}`;
    return Object.values(ModelNames).indexOf(modelName) !== -1;
  }
}
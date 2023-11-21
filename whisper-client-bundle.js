(() => {
  var FILE_UPLOAD_BTN = document.getElementById("file-input");
  var FORM_SUBMIT_BTN = document.getElementById("form-submit-btn");
  var MODEL_NAME_SELECTION_INPUT = document.getElementById("model-name-input");
  var VIDEO_PLAYER = document.getElementById("hyperplayer");
  var RESULTS_CONTAINER = document.getElementById("hypertranscript");
  var LOADING_MESSAGE_CONTAINER = document.getElementById("hypertranscript");

  console.log("....... about to create worker");

  var whisperWorkerPath = "whisper.worker.js";

  var MessageTypes = {
    DOWNLOADING: "DOWNLOADING",
    LOADING: "LOADING",
    RESULT: "RESULT",
    RESULT_PARTIAL: "RESULT_PARTIAL",
    INFERENCE_REQUEST: "INFERENCE_REQUEST",
    INFERENCE_DONE: "INFERENCE_DONE"
  };
  var LoadingStatus = {
    SUCCESS: "success",
    ERROR: "error",
    LOADING: "loading"
  };
  var ModelNames = {
    WHISPER_TINY_EN: "openai/whisper-tiny.en",
    WHISPER_TINY: "openai/whisper-tiny",
    WHISPER_BASE: "openai/whisper-base",
    WHISPER_BASE_EN: "openai/whisper-base.en",
    WHISPER_SMALL: "openai/whisper-small",
    WHISPER_SMALL_EN: "openai/whisper-small.en"
  };

  var WORKER;

  console.log("starting....");
  FORM_SUBMIT_BTN.disabled = true;
  FORM_SUBMIT_BTN.addEventListener("click", async (event2) => {
    await handleFormSubmission();
  });

  WORKER = createWorker();

  function createWorker() {
    console.log("In createWorker()");
    const worker = new Worker(whisperWorkerPath);
    let results = [];
    worker.onmessage = (event2) => {
      console.log("worker.onmessage event...");
      console.dir(event2.data);
      const { type } = event2.data;
      if (type === MessageTypes.LOADING) {
        handleLoadingMessage(event2.data);
      }
      if (type === MessageTypes.DOWNLOADING) {
        LOADING_MESSAGE_CONTAINER.innerHTML = '<div class="vertically-centre"><center>Downloading model...</center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
      }
      if (type === MessageTypes.RESULT) {
        handleResultMessage(event2.data);
        results = event2.data.results;
      }
      if (type === MessageTypes.RESULT_PARTIAL) {
        
      }
      if (type === MessageTypes.INFERENCE_DONE) {
        handleInferenceDone(results);
      }
    };
    console.log("returning worker...");
    console.dir(worker);
    return worker;
  }

  function handleLoadingMessage(data) {
    const { status } = data;

    if (status === LoadingStatus.SUCCESS) {
      LOADING_MESSAGE_CONTAINER.innerHTML = '<div class="vertically-centre"><center>Transcribing.... <span id="transcription-progress">0</span>%</center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
    }
    if (status === LoadingStatus.ERROR) {
      LOADING_MESSAGE_CONTAINER.innerHTML = '<div class="vertically-centre"><center>Oops! Something went wrong. Please refresh the page and try again.</center><br/><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"></div>';
    }
    if (status === LoadingStatus.LOADING) {
      LOADING_MESSAGE_CONTAINER.innerHTML = '<div class="vertically-centre"><center>Loading model into memory...</center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
    }
  }
  
  function handleResultMessage(data) {
    const { results, completedUntilTimestamp } = data;
    console.log("==== data ====")
    console.log(data);
    const totalDuration = VIDEO_PLAYER.duration;
    const progress = completedUntilTimestamp / totalDuration * 100;
    document.querySelector("#transcription-progress").innerHTML = Math.round(progress);
  }

  function handleInferenceDone(results) {

    console.log(results);

    VIDEO_PLAYER.currentTime = 0;

    let hypertranscript = "";
    results.forEach((result) => {
      let words = result.text.split(' ');
      let interval = (result.end - result.start) / words.length;
      let timecode = result.start * 1000;
      let duration = Math.floor((interval*1000)-1);
      words.forEach((word) => {
        let start = Math.floor(timecode);
        hypertranscript += `<span data-m='${start}' data-d='${duration}'>${word} </span>\n`;
        timecode += interval*1000;
      });

      RESULTS_CONTAINER.innerHTML = "<article>\n <section>\n  <p>\n" + hypertranscript + "  </p>\n </section>\n</article>\n";

      const initEvent = new CustomEvent('hyperaudioInit');
      document.dispatchEvent(initEvent);
      const capEvent = new CustomEvent('hyperaudioGenerateCaptionsFromTranscript');
      document.dispatchEvent(capEvent);
    });
  }

  async function handleFormSubmission() {
    console.log("In handleFormSubmission()");
    if (!isFileUploaded() || !isModelNameSelected()) {
      return;
    }
    
    const model_name = `openai/${MODEL_NAME_SELECTION_INPUT.value}`;
    const file = FILE_UPLOAD_BTN.files[0];
    const audio = await readAudioFrom(file);
    console.log("WORKER.postMessage");
    console.dir(MessageTypes.INFERENCE_REQUEST);
    WORKER.postMessage({
      type: MessageTypes.INFERENCE_REQUEST,
      audio,
      model_name
    });
    VIDEO_PLAYER.src = URL.createObjectURL(file);
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
    if (FILE_UPLOAD_BTN.files.length === 0) {
      return false;
    }
    return true;
  }

  function isModelNameSelected() {
    const selectedValue = MODEL_NAME_SELECTION_INPUT.value;
    if (MODEL_NAME_SELECTION_INPUT.value === "") {
      return false;
    }
    const modelName = `openai/${selectedValue}`;
    return Object.values(ModelNames).indexOf(modelName) !== -1;
  }

  const transcribingSvg = "data:image/svg+xml,%3Csvg width='45' height='45' viewBox='0 0 45 45' xmlns='http://www.w3.org/2000/svg' stroke='%23000'%3E%3Cg fill='none' fill-rule='evenodd' transform='translate(1 1)' stroke-width='2'%3E%3Ccircle cx='22' cy='22' r='6' stroke-opacity='0'%3E%3Canimate attributeName='r' begin='1.5s' dur='3s' values='6;22' calcMode='linear' repeatCount='indefinite' /%3E%3Canimate attributeName='stroke-opacity' begin='1.5s' dur='3s' values='1;0' calcMode='linear' repeatCount='indefinite' /%3E%3Canimate attributeName='stroke-width' begin='1.5s' dur='3s' values='2;0' calcMode='linear' repeatCount='indefinite' /%3E%3C/circle%3E%3Ccircle cx='22' cy='22' r='6' stroke-opacity='0'%3E%3Canimate attributeName='r' begin='3s' dur='3s' values='6;22' calcMode='linear' repeatCount='indefinite' /%3E%3Canimate attributeName='stroke-opacity' begin='3s' dur='3s' values='1;0' calcMode='linear' repeatCount='indefinite' /%3E%3Canimate attributeName='stroke-width' begin='3s' dur='3s' values='2;0' calcMode='linear' repeatCount='indefinite' /%3E%3C/circle%3E%3Ccircle cx='22' cy='22' r='8'%3E%3Canimate attributeName='r' begin='0s' dur='1.5s' values='6;1;2;3;4;5;6' calcMode='linear' repeatCount='indefinite' /%3E%3C/circle%3E%3C/g%3E%3C/svg%3E";

  const errorSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' width='256' height='256' viewBox='0 0 256 256' xml:space='preserve'%3E%3Cdefs%3E%3C/defs%3E%3Cg style='stroke: none; stroke-width: 0; stroke-dasharray: none; stroke-linecap: butt; stroke-linejoin: miter; stroke-miterlimit: 10; fill: none; fill-rule: nonzero; opacity: 1;' transform='translate(1.4065934065934016 1.4065934065934016) scale(2.81 2.81)' %3E%3Cpath d='M 85.429 85.078 H 4.571 c -1.832 0 -3.471 -0.947 -4.387 -2.533 c -0.916 -1.586 -0.916 -3.479 0 -5.065 L 40.613 7.455 C 41.529 5.869 43.169 4.922 45 4.922 c 0 0 0 0 0 0 c 1.832 0 3.471 0.947 4.386 2.533 l 40.429 70.025 c 0.916 1.586 0.916 3.479 0.001 5.065 C 88.901 84.131 87.261 85.078 85.429 85.078 z M 45 7.922 c -0.747 0 -1.416 0.386 -1.79 1.033 L 2.782 78.979 c -0.373 0.646 -0.373 1.419 0 2.065 c 0.374 0.647 1.042 1.033 1.789 1.033 h 80.858 c 0.747 0 1.416 -0.387 1.789 -1.033 s 0.373 -1.419 0 -2.065 L 46.789 8.955 C 46.416 8.308 45.747 7.922 45 7.922 L 45 7.922 z M 45 75.325 c -4.105 0 -7.446 -3.34 -7.446 -7.445 s 3.34 -7.445 7.446 -7.445 s 7.445 3.34 7.445 7.445 S 49.106 75.325 45 75.325 z M 45 63.435 c -2.451 0 -4.446 1.994 -4.446 4.445 s 1.995 4.445 4.446 4.445 s 4.445 -1.994 4.445 -4.445 S 47.451 63.435 45 63.435 z M 45 57.146 c -3.794 0 -6.882 -3.087 -6.882 -6.882 V 34.121 c 0 -3.794 3.087 -6.882 6.882 -6.882 c 3.794 0 6.881 3.087 6.881 6.882 v 16.144 C 51.881 54.06 48.794 57.146 45 57.146 z M 45 30.239 c -2.141 0 -3.882 1.741 -3.882 3.882 v 16.144 c 0 2.141 1.741 3.882 3.882 3.882 c 2.14 0 3.881 -1.741 3.881 -3.882 V 34.121 C 48.881 31.98 47.14 30.239 45 30.239 z' style='stroke: none; stroke-width: 1; stroke-dasharray: none; stroke-linecap: butt; stroke-linejoin: miter; stroke-miterlimit: 10; fill: rgb(0,0,0); fill-rule: nonzero; opacity: 1;' transform=' matrix(1 0 0 1 0 0) ' stroke-linecap='round' /%3E%3C/g%3E%3C/svg%3E";
  })();

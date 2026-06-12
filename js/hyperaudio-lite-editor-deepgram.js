/**
 * hyperaudio-lite-editor-deepgram.js
 * (C) The Hyperaudio Project
 * @version 0.6.7 — last changed in release 0.6.7
 * @license MIT
 */

const DEEPGRAM_LANGUAGE_LABELS = {
  "en": "English",
  "en-US": "English (United States)",
  "en-GB": "English (Great Britain)",
  "en-AU": "English (Australia)",
  "en-IN": "English (India)",
  "en-NZ": "English (New Zealand)",
  "es": "Spanish",
  "es-419": "Spanish (Latin America)",
  "fr": "French",
  "fr-CA": "French (Canada)",
  "de": "German",
  "hi": "Hindi",
  "hi-Latn": "Hindi (Latin Script)",
  "it": "Italian",
  "ja": "Japanese",
  "ko": "Korean",
  "nl": "Dutch",
  "no": "Norwegian",
  "pl": "Polish",
  "pt": "Portuguese",
  "pt-BR": "Portuguese (Brazil)",
  "pt-PT": "Portuguese (Portugal)",
  "ru": "Russian",
  "sv": "Swedish",
  "ta": "Tamil",
  "tr": "Turkish",
  "uk": "Ukrainian",
  "id": "Indonesian",
  "da": "Danish",
  "zh": "Chinese",
  "zh-CN": "Chinese, Simplified Mandarin (China)",
  "zh-TW": "Chinese, Traditional Mandarin (Taiwan)",
  "multi": "Multilingual (code-switching)"
};

const DEEPGRAM_MODELS = [
  {
    value: "nova-3",
    label: "Nova-3 (recommended)",
    languages: ["en", "en-US", "es", "fr", "de", "hi", "it", "ja", "ko", "nl", "pl", "pt", "ru", "sv", "tr", "uk", "multi"]
  },
  {
    value: "nova-2",
    label: "Nova-2",
    languages: ["en", "en-US", "en-GB", "en-AU", "en-IN", "en-NZ", "zh", "zh-CN", "zh-TW", "da", "nl", "fr", "fr-CA", "de", "hi", "hi-Latn", "id", "it", "ja", "ko", "no", "pl", "pt", "pt-BR", "pt-PT", "ru", "es", "es-419", "sv", "ta", "tr", "uk"]
  },
  { value: "nova-2-meeting", label: "Nova-2 — Meeting", languages: ["en", "en-US"] },
  { value: "nova-2-phonecall", label: "Nova-2 — Phone Call", languages: ["en", "en-US"] },
  { value: "nova-2-finance", label: "Nova-2 — Finance", languages: ["en", "en-US"] },
  { value: "nova-2-medical", label: "Nova-2 — Medical", languages: ["en", "en-US"] },
  {
    value: "enhanced",
    label: "Enhanced",
    languages: ["en", "en-US", "da", "nl", "fr", "de", "hi", "it", "ja", "ko", "no", "pl", "pt", "pt-BR", "ru", "es", "sv", "ta", "tr", "uk"]
  },
  {
    value: "base",
    label: "Base",
    languages: ["en", "en-US", "en-GB", "en-AU", "en-IN", "en-NZ", "zh", "zh-CN", "zh-TW", "nl", "fr", "fr-CA", "de", "hi", "hi-Latn", "id", "it", "ja", "ko", "no", "pl", "pt", "pt-BR", "pt-PT", "ru", "es", "es-419", "sv", "ta", "tr", "uk"]
  }
];

class DeepgramService extends HTMLElement {

  constructor() {
    super();
  }

  configureLanguage() {
    const selectModel = document.querySelector('#deepgram-form #language-model');
    DEEPGRAM_MODELS.forEach((model, index) => {
      const option = document.createElement("option");
      option.value = model.value;
      option.innerHTML = model.label;
      if (index === 0) {
        option.selected = "selected";
      }
      selectModel.appendChild(option);
    });
    populateLanguagesForModel(DEEPGRAM_MODELS[0].value);
  }

  clearMediaUrl(event) {
    event.preventDefault();
    document.querySelector('#deepgram-media').value = "";
  }

  clearFilePicker(event) {
    event.preventDefault();
    document.querySelector('#deepgram-file').value = "";
  }
  
  updatePlayerWithLocalFile(event) {
    const file = document.querySelector('#deepgram-file').files[0];
    // Create a new FileReader instance
    const reader = new FileReader();
    
    reader.readAsArrayBuffer(file);
    let blob = null;

    reader.addEventListener('load', () => {

      file.arrayBuffer().then((arrayBuffer) => {
        blob = new Blob([new Uint8Array(arrayBuffer)], {type: file.type });

        let player = document.querySelector("#hyperplayer");
        player.src = URL.createObjectURL(blob);
      });
    });
  }

  updateDropdowns(event) {
    const model = document.querySelector('#deepgram-form #language-model').value;
    populateLanguagesForModel(model);
  }

  getData(event) {
    // If the user is in caption mode, switch back to transcript view so the
    // transcribing loader is visible and the result lands in the right place.
    // #transcript-editor-btn is disabled in transcript mode, so this no-ops.
    document.querySelector('#transcript-editor-btn')?.click();
    document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><center>Transcribing....</center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
    if (typeof setTranscriptBusy === 'function') {
      setTranscriptBusy(true);
    }
    const language = document.querySelector('#language').value;
    const model = document.querySelector('#language-model').value;
    let media =  document.querySelector('#deepgram-media').value;
    const token =  document.querySelector('#token').value;
    const file = document.querySelector('#deepgram-file').files[0];

    transcriptionStart = Date.now();
    transcriptionMeta = {
      service: "Deepgram (cloud)",
      model: document.querySelector('#language-model').selectedOptions[0]?.textContent || model,
      language: document.querySelector('#language').selectedOptions[0]?.textContent || language,
    };

    if (media.toLowerCase().startsWith("https://") === false && media.toLowerCase().startsWith("http://") === false) {
      media = "https://"+media;
    }

    if (file !== undefined) {
      fetchDataLocal(token, file, language, model);
      document.querySelector('#deepgram-media').value = "";
    } else {
      if (media !== "" || token !== "") {
        let player = document.querySelector("#hyperplayer");
        player.src = media;
        fetchData(token, media, language, model);
      } else {
        document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Please include both a link to the media and token in the form. </center></div>';
        if (typeof setTranscriptBusy === 'function') {
          setTranscriptBusy(false);
        }
      }
    }
  }

  connectedCallback() {

    let template = null;
    let modal = this;

    const templateUrl = this.getAttribute("templateUrl");
    const templateSelector = this.getAttribute("templateSelector");

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
          let deepgramTempl = template.querySelector('#deepgram-modal-template').cloneNode(true);
          modal.innerHTML = deepgramTempl.innerHTML;
          modal.configureLanguage();
          addModalEventListeners(modal);
        })
        .catch(function(err) {  
          console.log('Template error: ', err);  
        });
    } else {
      modal.innerHTML = document.querySelector(templateSelector).innerHTML;
      document.querySelector(templateSelector).remove();
      modal.configureLanguage();
      addModalEventListeners(modal);
    }
  }
}

customElements.define('deepgram-service', DeepgramService);

function addModalEventListeners(modal) {
  document.querySelector('#deepgram-file').addEventListener('change',modal.clearMediaUrl);
  document.querySelector('#deepgram-media').addEventListener('change',modal.clearFilePicker);
  document.querySelector('#transcribe-btn').addEventListener('click', (event) => {
    if (document.querySelector('#transcribe-btn').classList.contains('btn-disabled')) {
      return;
    }
    modal.getData(event);
  });
  document.querySelector('#deepgram-file').addEventListener('change', modal.updatePlayerWithLocalFile);
  document.querySelector('#language-model').addEventListener('change', modal.updateDropdowns);

  // the button is a styled <label>, so "disabled" is the btn-disabled class
  // (pointer-events: none) plus the guard above. A token alone is not enough
  // to transcribe – media is what enables the button.
  const updateTranscribeState = () => {
    const hasFile = document.querySelector('#deepgram-file').files.length > 0;
    const hasMedia = document.querySelector('#deepgram-media').value.trim() !== '';
    const button = document.querySelector('#transcribe-btn');
    button.classList.toggle('btn-disabled', !(hasFile || hasMedia));
    button.setAttribute('aria-disabled', String(!(hasFile || hasMedia)));
  };
  document.querySelector('#deepgram-file').addEventListener('change', updateTranscribeState);
  document.querySelector('#deepgram-media').addEventListener('input', updateTranscribeState);
  updateTranscribeState();
}

function fetchData(token, media, language, model) {

  let url = getApiUrl(language, model);

  fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Token '+token+'',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      'url': media
    })
  })
  .then(response => {
    if (!response.ok) {
      throw new Error(response.status);
    } else {
      console.log("response ok");
    }

    return response.json();
  })
  .then(json => {
    console.dir(json);

    if (json.results.channels[0] === undefined || json.results.channels[0].alternatives[0].words.length === 0) {
      displayNoWordsError();
    } else {
      parseData(json);
    }
  })
  .catch(function (error) {
    displayAppropriateErrorMessage(error);
  })
}

function fetchDataLocal(token, file, language, model) {

  const apiKey = token;

  const reader = new FileReader();

  reader.readAsArrayBuffer(file);
  let blob = null;

  reader.addEventListener('load', () => {

    file.arrayBuffer().then((arrayBuffer) => {
      blob = new Blob([new Uint8Array(arrayBuffer)], {type: file.type });

      let player = document.querySelector("#hyperplayer");
      player.src = URL.createObjectURL(blob);

      let url = getApiUrl(language, model);

      if (token !== "") {
        fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': 'Token ' + apiKey,
            'Content-Type': file.type
          },
          body: blob
        })
        .then(response => {
          if (!response.ok) {
            throw new Error(response.status);
          } else {
            console.log("response ok");
          }
          return response.json();
        })
        .then(json => {
          if (json.results.channels[0] === undefined || json.results.channels[0].alternatives[0].words.length === 0) {
            displayNoWordsError();
          } else {
            parseData(json);
          }
        })
        .catch(function (error) {
          displayAppropriateErrorMessage(error);
        })
      } else {
        document.querySelector('#hypertranscript').innerHTML = '';
        if (typeof setTranscriptBusy === 'function') {
          setTranscriptBusy(false);
        }
      }
    });
  });
}

function getApiUrl(language, model) {
  const languageParam = (language === "xx") ? "&detect_language=true" : `&language=${language}`;
  return `https://api.deepgram.com/v1/listen?model=${model}${languageParam}&diarize=true&summarize=v2&topics=true&smart_format=true`;
}

function displayAppropriateErrorMessage(error) {
  if (typeof setTranscriptBusy === 'function') {
    setTranscriptBusy(false);
  }
  console.dir("error is : " + error);
  error = error + "";

  if (error.indexOf("401") > 0 || error.indexOf("400") > 0) {
    document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>It appears that the media URL does not exist<br/> or the token is invalid.</center></div>';
    return;
  }
  if (error.indexOf("402") > 0) {
    document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>It appears that the token is invalid.</center></div>';
    return;
  }
  displayGenericError();
}

function displayGenericError() {
  document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>An unexpected error has occurred.</center></div>';
}

function displayNoWordsError() {
  if (typeof setTranscriptBusy === 'function') {
    setTranscriptBusy(false);
  }
  document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>No words were detected.<br/>Please verify that audio contains speech.</center></div>';
}


function getLanguageCode(json){
  // prepare the VTT track so that the correct language is defined

  let language = document.querySelector('#language').value;

  if (language === undefined) {
    let detectedLanguage = extractLanguage(json);
    if (detectedLanguage !== undefined) {
      language = detectedLanguage;
    } else {
      language = "language unknown";
    }
  } 

  return (language);
}

let transcriptionStart = 0;
let transcriptionMeta = {};

function parseData(json) {

  const maxWordsInPara = 100;
  const significantGapInSeconds = 4.0;

  const punctuatedWords = json.results.channels[0].alternatives[0].transcript.split(' ');
  const wordData = json.results.channels[0].alternatives[0].words;
  console.log("wordData...");
  console.log(wordData);

  // Fix Deepgram diarization edge case where the last word of a speaker turn
  // gets attached to the next speaker. Signature: the word starts essentially
  // on top of the previous speaker's word, but the next word from this "new"
  // speaker is far away. In that case, reassign the word back.
  const speakerReassignGap = 0.3;
  for (let i = 1; i < wordData.length - 1; i++) {
    const prev = wordData[i - 1];
    const cur = wordData[i];
    const next = wordData[i + 1];
    if (cur.speaker !== prev.speaker && next.speaker === cur.speaker) {
      const gapBefore = cur.start - prev.end;
      const gapAfter = next.start - cur.end;
      if (gapBefore < speakerReassignGap && gapAfter > speakerReassignGap) {
        cur.speaker = prev.speaker;
      }
    }
  }

  let hyperTranscript = "<article>\n <section>\n  <p>\n   ";

  let previousElementEnd = 0;
  let wordsInPara = 0;
  let showDiarization = true;

  if (document.querySelector("#summary") !== null) {
    document.querySelector("#summary").innerHTML = extractSummary(json);
  }

  if (document.querySelector("#topics") !== null) {
    document.querySelector("#topics").innerHTML = extractTopics(json).join(", ");
  }

  language = getLanguageCode(json);
  
  let track = document.querySelector('#hyperplayer-vtt');
  track.label = language;
  track.srcLang = language;

  wordData.forEach((element, index) => {

    let currentWord = punctuatedWords[index];
    wordsInPara++;

    // if there's a gap longer than half a second consider splitting into new para

    if (previousElementEnd !== 0 && (element.start - previousElementEnd) > significantGapInSeconds || wordsInPara > maxWordsInPara){
      let previousWord = punctuatedWords[index-1];
      let previousWordLastChar = previousWord.charAt(previousWord.length-1);
      if (previousWordLastChar === "." || previousWordLastChar === "?" || previousWordLastChar === "!") {
        hyperTranscript += "\n  </p>\n  <p>\n   ";
        wordsInPara = 0;
      }
    }

    // change of speaker or first word - always start a new paragraph on speaker change
    if ((showDiarization === true && index > 0 && element.speaker !== wordData[index-1].speaker) || index === 0) {
      if (index > 0) {
        hyperTranscript += "\n  </p>\n  <p>\n   ";
        wordsInPara = 0;
      }
      hyperTranscript += `<span class="speaker" data-m='${element.start.toFixed(2)*1000}' data-d='0'>[speaker-${element.speaker}] </span>`;
    }

    hyperTranscript += `<span data-m='${element.start.toFixed(2)*1000}' data-d='${(element.end - element.start).toFixed(2)*1000}'>${currentWord} </span>`;

    previousElementEnd = element.end;
  });

  hyperTranscript +=  "\n </p> \n </section>\n</article>\n ";

  hyperTranscript = hyperTranscript.replace(/<p>\s*<\/p>\s*/g, '');

  document.querySelector("#hypertranscript").innerHTML = hyperTranscript;

  let showSpeakers = document.querySelector('#show-speakers');
  let speakers = document.querySelectorAll('.speaker');

  if (showSpeakers.checked === true) {
    speakers.forEach((speaker) => {
      speaker.style.display = "inline";
    });
  } else {
    speakers.forEach((speaker) => {
      speaker.style.display = "none";
    });
  }

  console.log("updating download html link");
  document.querySelector('#download-html').setAttribute('href', 'data:text/html,'+encodeURIComponent(hyperTranscript));

  if (typeof setTranscriptionInfo === 'function' && transcriptionStart !== 0) {
    setTranscriptionInfo({ ...transcriptionMeta, seconds: (Date.now() - transcriptionStart) / 1000 });
  }
  if (typeof setTranscriptBusy === 'function') {
    setTranscriptBusy(false);
  }

  const initEvent = new CustomEvent('hyperaudioInit');
  document.dispatchEvent(initEvent);
  const capEvent = new CustomEvent('hyperaudioGenerateCaptionsFromTranscript');
  document.dispatchEvent(capEvent);
}

function extractSummary(json) {
  const summary = json.results && json.results.summary;
  if (!summary) return "";
  return summary.short || summary.text || "";
}

function extractTopics(json) {
  const topicsData = json.results && json.results.topics;
  if (!topicsData || !Array.isArray(topicsData.segments)) return [];
  const seen = new Set();
  topicsData.segments.forEach(segment => {
    (segment.topics || []).forEach(t => {
      if (t && t.topic && !seen.has(t.topic)) {
        seen.add(t.topic);
      }
    });
  });
  return Array.from(seen);
}

function extractLanguage(json) {
  let language = json.results.channels[0].detected_language;
  return (language);
}

function populateLanguagesForModel(modelValue) {
  const select = document.querySelector('#language');
  if (!select) return;
  select.innerHTML = "";

  const model = DEEPGRAM_MODELS.find(m => m.value === modelValue) || DEEPGRAM_MODELS[0];
  model.languages.forEach(code => {
    const option = document.createElement("option");
    option.value = code;
    option.innerHTML = DEEPGRAM_LANGUAGE_LABELS[code] || code;
    select.appendChild(option);
  });
}

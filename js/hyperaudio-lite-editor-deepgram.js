/*! (C) The Hyperaudio Project. MIT @license: en.wikipedia.org/wiki/MIT_License. */
/*! Version 1.0.1 */

class DeepgramService extends HTMLElement {

  constructor() {
    super();
  }

  configureLanguage() {

    populateLanguageDeepgram();

    const selectModel = document.querySelector('#deepgram-form #language-model');
    const optionLanguageModel = {
      "General": "general",
      "Whisper (Tiny)": "whisper-tiny",
      "Whisper (Base)": "whisper-base",
      "Whisper (Small)": "whisper-small",
      "Whisper (Medium)": "whisper-medium",
      "Whisper (Large)": "whisper-large",
      "Meeting": "meeting",
      "Phone call": "phonecall",
      "Voicemail": "voicemail",
      "Finance": "finance",
      "Conversational AI": "conversationalai",   
    }

    let counter = 0
    Object.keys(optionLanguageModel).forEach( model => {
      let option = document.createElement("option")
      option.value = optionLanguageModel[model]
      option.innerHTML = `${model}`
      if (counter === 0) {
        option.selected = "selected"
      }
      selectModel.appendChild(option);
      counter += 1;
    } );
  }

  clearMediaUrl(event) {
    event.preventDefault();
    document.querySelector('#media').value = "";
  }

  clearFilePicker(event) {
    event.preventDefault();
    document.querySelector('#file').value = "";
  }
  
  updatePlayerWithLocalFile(event) {
    const file = document.querySelector('[name=file]').files[0];
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
    let model = document.querySelector('#deepgram-form #language-model').value;

    // update languages depending on model
    if (model.startsWith("whisper")){
      populateLanguageWhisper();
    } else {
      if (model === "general") {
        populateLanguageDeepgram();
      } else {
        populateLanguageDeepgramRestricted();
      }
    }
  }

  updateTierDropdown(event) {

    const deepgramModelCompatibility = {
      "zh_general": ["base"],
      "zh-CN_general": ["base"],
      "zh-TW_general": ["base"],
      "da_general": ["enhanced", "base"],
      "nl_general":	["enhanced", "base"],
      "en_general": ["nova", "enhanced", "base"],
      "en_meeting": ["enhanced", "base"],
      "en_phonecall": ["nova", "enhanced", "base"],
      "en_voicemail": ["base"],
      "en_finance": ["enhanced", "base"],
      "en_conversationalai": ["base"],
      "en_video": ["base"],
      "en-AU_general": ["nova", "base"],
      "en-GB_general": ["nova", "base"],
      "en-IN_general": ["nova", "base"],
      "en-NZ_general": ["nova", "base"],
      "en-US_general": ["nova", "enhanced", "base"],
      "en-US_meeting": ["enhanced", "base"],
      "en-US_phonecall": ["nova", "enhanced", "base"],
      "en-US_voicemail": ["base"],
      "en-US_finance": ["enhanced", "base"],
      "en-US_conversationalai": ["base"],
      "en-US_video": ["base"],
      "nl_general": ["enhanced", "base"],
      "fr_general": ["enhanced" , "base"],
      "fr-CA_general": ["base"],
      "de_general": ["enhanced", "base"],
      "hi_general":	["enhanced", "base"],
      "hi-Latn_general": ["base"],
      "id_general":	["base"],
      "it_general": ["enhanced", "base"],
      "ja_general": ["enhanced", "base"],
      "ko_general": ["enhanced", "base"],
      "no_general":["enhanced", "base"],
      "pl_general":["enhanced", "base"],
      "pt_general":	["enhanced", "base"],
      "pt-BR_general": ["enhanced", "base"],
      "pt-PT_general": ["enhanced", "base"],
      "ru_general": ["base"],
      "es_general": ["enhanced", "base"],
      "es-419_general": ["enhanced", "base"],
      "sv_general": ["enhanced", "base"],
      "ta_general":	["enhanced"],
      "tr_general": ["base"],
      "uk_general": ["base"]
    }

    let model = document.querySelector('#deepgram-form #language-model').value;
    let lang = document.querySelector('#deepgram-form #language').value;
    let tiers = deepgramModelCompatibility[lang+"_"+model];

    let options = document.querySelector('#tier').options;

    for (let option of options) {
      option.disabled = true;
      if (typeof tiers !== "undefined" && tiers.length > 0 && tiers.includes(option.value)) {
        option.disabled = false;
      }
    };
  }

  getData(event) {
    document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><center>Transcribing....</center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
    const language = document.querySelector('#language').value;
    const model = document.querySelector('#language-model').value;
    let media =  document.querySelector('#media').value;
    const token =  document.querySelector('#token').value;
    const file = document.querySelector('[name=file]').files[0];
    let tier = document.querySelector('#tier').value;

    if (media.toLowerCase().startsWith("https://") === false && media.toLowerCase().startsWith("http://") === false) {
      media = "https://"+media;
    }

    if (file !== undefined) {
      fetchDataLocal(token, file, tier, language, model);
      document.querySelector('#media').value = "";
    } else {
      if (media !== "" || token !== "") {
        let player = document.querySelector("#hyperplayer");
        player.src = media;
        fetchData(token, media, tier, language, model);
      } else {
        document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Please include both a link to the media and token in the form. </center></div>';
      }
    }
  }

  connectedCallback() {

    let template = null;
    let modal = this;

    const templateUrl = this.getAttribute("templateUrl");
    const templateSelector = this.getAttribute("templateSelector");

    console.log(templateUrl);
    console.log(templateSelector);

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
  document.querySelector('#file').addEventListener('change',modal.clearMediaUrl);
  document.querySelector('#media').addEventListener('change',modal.clearFilePicker);
  document.querySelector('#transcribe-btn').addEventListener('click', modal.getData);
  document.querySelector('#file').addEventListener('change', modal.updatePlayerWithLocalFile);
  document.querySelector('#language-model').addEventListener('change', modal.updateDropdowns);
  document.querySelector('#language-model').addEventListener('change', modal.updateTierDropdown);
  document.querySelector('#language').addEventListener('change', modal.updateTierDropdown);
}

function fetchData(token, media, tier, language, model) {

  let url = null;
  let languageParam = `&language=${language}`;
  if (language === "xx") {
    //signifies autodetect
    languageParam  = "&detect_language=true";
  }

  if (model.startsWith("whisper")) { // no tier
    url = `https://api.deepgram.com/v1/listen?model=${model}${languageParam}&diarize=true&summarize=true&detect_topics=true&smart_format=true`
  } else {
    url = `https://api.deepgram.com/v1/listen?model=${model}&tier=${tier}&diarize=true&summarize=true&detect_topics=true&language=${language}&smart_format=true`
  }
  
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
    console.dir("error is : "+error);
    error = error + "";

    let errorDisplayed = displayError(error, tier);
    
    if (error.indexOf("400") > 0 && tier === "enhanced") {
      tier = "base";
      fetchData(token, media, tier, language, model);
    }

    if (error.indexOf("400") > 0 && tier === "nova") {
      tier = "enhanced";
      fetchData(token, media, tier, language, model);
    }

    this.dataError = true;

    if (errorDisplayed === false) {
      displayGenericError();
    }
  })
}

function fetchDataLocal(token, file, tier, language, model) {


  let url = null;
  let languageParam = `&language=${language}`;
  if (language === "xx") {
    //signifies autodetect
    languageParam  = "&detect_language=true";
  }

  if (model.startsWith("whisper")) { // no tier
    url = `https://api.deepgram.com/v1/listen?model=${model}${languageParam}&diarize=true&summarize=true&detect_topics=true&smart_format=true`
  } else {
    url = `https://api.deepgram.com/v1/listen?model=${model}&tier=${tier}&diarize=true&summarize=true&detect_topics=true&language=${language}&smart_format=true`
  }
  const apiKey = token;

  // Create a new FileReader instance
  const reader = new FileReader();
  
  reader.readAsArrayBuffer(file);
  let blob = null;

  reader.addEventListener('load', () => {

    file.arrayBuffer().then((arrayBuffer) => {
      blob = new Blob([new Uint8Array(arrayBuffer)], {type: file.type });

      let player = document.querySelector("#hyperplayer");
      player.src = URL.createObjectURL(blob);

      // if the token is not present we just add the media to the player
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
          // check to see if any transcript data has come back before proceeding, give error message if not
          if (json.results.channels[0] === undefined || json.results.channels[0].alternatives[0].words.length === 0) {
            displayNoWordsError();
          } else {
            parseData(json);
          }
        })
        .catch(function (error) {
          console.dir("error is : "+error);
          error = error + "";
      
          let errorDisplayed = displayError(error, tier);
          
          if (error.indexOf("400") > 0 && tier === "enhanced") {
            tier = "base";
            fetchDataLocal(token, file, tier, language, model);
          }
      
          this.dataError = true;

          if (errorDisplayed === false) {
            displayGenericError();
          }
        })
      } else {
        document.querySelector('#hypertranscript').innerHTML = ''; 
      }
    });
  });
}

function displayError(error, tier) {
  if (error.indexOf("401") > 0 || (error.indexOf("400") > 0 && tier === "base")) {
    document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>It appears that the media URL does not exist<br/> or the token is invalid.</center></div>';
    return true;
  }
  if (error.indexOf("402") > 0) {
    document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>It appears that the token is invalid.</center></div>';
    return true;
  }
  return false;
}

function displayGenericError() {
  document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="'+errorSvg+'" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>An unexpected error has occurred.</center></div>';
}

function displayNoWordsError() {
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

function parseData(json) {

  const maxWordsInPara = 100;
  const significantGapInSeconds = 0.5;

  const punctuatedWords = json.results.channels[0].alternatives[0].transcript.split(' ');
  const wordData = json.results.channels[0].alternatives[0].words;
  console.log("wordData...");
  console.log(wordData);

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

    // change of speaker or first word
    if ((showDiarization === true && index > 0 && element.speaker !== wordData[index-1].speaker) || index === 0) { 
      let previousWord = punctuatedWords[index-1];
      let previousWordLastChar = null;
      
      if (index > 0) {
        previousWordLastChar = previousWord.charAt(previousWord.length-1);
      }

      if (index > 0 && (previousWordLastChar === "." || previousWordLastChar === "?" || previousWordLastChar === "!")) {
        hyperTranscript += "\n  </p>\n  <p>\n   ";
        wordsInPara = 0;
      }
      hyperTranscript += `<span class="speaker" data-m='${element.start.toFixed(2)*1000}' data-d='0'>[speaker-${element.speaker}] </span>`;
    }

    hyperTranscript += `<span data-m='${element.start.toFixed(2)*1000}' data-d='${(element.end - element.start).toFixed(2)*1000}'>${currentWord} </span>`;

    previousElementEnd = element.end;
  });

  hyperTranscript +=  "\n </p> \n </section>\n</article>\n ";
  
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

  const initEvent = new CustomEvent('hyperaudioInit');
  document.dispatchEvent(initEvent);
  const capEvent = new CustomEvent('hyperaudioGenerateCaptionsFromTranscript');
  document.dispatchEvent(capEvent);
}

function extractSummary(json) {
  let summary = "";
  const summaryData = json.results.channels[0].alternatives[0].summaries;

  summaryData.forEach((element, index) => {
    summary += element.summary;
    if (index < summaryData.length - 1) {
      summary += "\n\n";
    }
  });

  return (summary);
}

function extractTopics(json) {
  let topics = [];
  const topicsData = json.results.channels[0].alternatives[0].topics;

  topicsData.forEach(element => {
    element.topics.forEach(el => {
      topics.push(el.topic);
    });
  });

  return (topics);
}

function extractLanguage(json) {
  let language = json.results.channels[0].detected_language;
  return (language);
}

function populateLanguageDeepgram() {

  const select = document.querySelector('#language');
  select.innerHTML = "";

  const optionLanguage = {
    "English": "en",
    "English (United States)": "en-US",
    "English (Great Britain)": "en-GB",
    "English (Australia)": "en-AU",
    "English (India)" : "en-IN",
    "English (New Zealand)" : "en-NZ",
    "Chinese": "zh",
    "Chinese, Simplified Mandarin (China)": "zh-CN",
    "Chinese, Traditional Mandarin (Taiwan)": "zh-TW",
    "Dutch": "nl",
    "French" : "fr",
    "French (Canada)" : "fr-CA",
    "German" : "de",
    "Hindi" : "hi",
    "Hindi (Latin Script)" : "hi-Latn",
    "Indonesian" : "id",
    "Italian": "it",
    "Japanese" : "ja",
    "Korean" : "ko",
    "Polish" : "pl",
    "Portuguese": "pt",
    "Portuguese (Brazil)" : "pt-BR",
    "Portuguese (Portugal)" : "pt-PT",
    "Russian" : "ru",
    "Spanish" : "es",
    "Swedish" : "sv",
    "Turkish" : "tr",
    "Ukrainian": "uk"
  }

  Object.keys(optionLanguage).forEach( language => {
    let option = document.createElement("option")
    option.value = optionLanguage[language]
    option.innerHTML = `${language}`
    select.appendChild(option);
  } );

  document.querySelector("#tier").disabled=false;
}

function populateLanguageWhisper() {

  const select = document.querySelector('#language');
  select.innerHTML = "";

  const optionLanguage = {
    "Auto Detect": "xx",
    "English": "en",
    "Afrikaans": "af",
    "Arabic": "ar",
    "Armenian": "hy",
    "Azerbaijani": "az",
    "Belarusian": "be",
    "Bosnian": "bs",
    "Bulgarian": "bg",
    "Catalan": "ca",
    "Chinese": "zh",
    "Croatian": "hr",
    "Czech": "cs",
    "Danish": "da",
    "Dutch": "nl",
    "Estonian": "et",
    "Finnish": "fi",
    "French": "fr",
    "Galician": "gl",
    "German": "de",
    "Greek": "el",
    "Hebrew": "he",
    "Hindi": "hi",
    "Hungarian": "hu",
    "Icelandic": "is",
    "Indonesian": "id",
    "Italian": "it",
    "Japanese": "ja",
    "Kannada": "kn",
    "Kazakh": "kk",
    "Korean": "ko",
    "Latvian": "lv",
    "Lithuanian": "lt",
    "Macedonian": "mk",
    "Malay": "ms",
    "Marathi": "mr",
    "Maori": "mi",
    "Nepali": "ne",
    "Norwegian": "no",
    "Persian": "fa",
    "Polish": "pl",
    "Portuguese": "pt",
    "Romanian": "ro",
    "Russian": "ru",
    "Serbian": "sr",
    "Slovak": "sk",
    "Slovenian": "sl",
    "Spanish": "es",
    "Swahili": "sw",
    "Swedish": "sv",
    "Tagalog": "tl",
    "Tamil": "ta",
    "Thai": "th",
    "Turkish": "tr",
    "Ukrainian": "uk",
    "Urdu": "ur",
    "Vietnamese": "vi",
    "Welsh": "cy"
  };

  Object.keys(optionLanguage).forEach( language => {
    let option = document.createElement("option");
    option.value = optionLanguage[language];
    option.innerHTML = `${language}`
    select.appendChild(option);
  } );

  document.querySelector("#tier").disabled=true;
}

function populateLanguageDeepgramRestricted() {

  const select = document.querySelector('#language');
  select.innerHTML = "";

  const optionLanguage = {
    "English": "en",
    "English (United States)": "en-US"
  }

  Object.keys(optionLanguage).forEach( language => {
    let option = document.createElement("option")
    option.value = optionLanguage[language]
    option.innerHTML = `${language}`
    select.appendChild(option);
  } );

  document.querySelector("#tier").disabled=false;
}

const transcribingSvg = "data:image/svg+xml,%3Csvg width='45' height='45' viewBox='0 0 45 45' xmlns='http://www.w3.org/2000/svg' stroke='%23000'%3E%3Cg fill='none' fill-rule='evenodd' transform='translate(1 1)' stroke-width='2'%3E%3Ccircle cx='22' cy='22' r='6' stroke-opacity='0'%3E%3Canimate attributeName='r' begin='1.5s' dur='3s' values='6;22' calcMode='linear' repeatCount='indefinite' /%3E%3Canimate attributeName='stroke-opacity' begin='1.5s' dur='3s' values='1;0' calcMode='linear' repeatCount='indefinite' /%3E%3Canimate attributeName='stroke-width' begin='1.5s' dur='3s' values='2;0' calcMode='linear' repeatCount='indefinite' /%3E%3C/circle%3E%3Ccircle cx='22' cy='22' r='6' stroke-opacity='0'%3E%3Canimate attributeName='r' begin='3s' dur='3s' values='6;22' calcMode='linear' repeatCount='indefinite' /%3E%3Canimate attributeName='stroke-opacity' begin='3s' dur='3s' values='1;0' calcMode='linear' repeatCount='indefinite' /%3E%3Canimate attributeName='stroke-width' begin='3s' dur='3s' values='2;0' calcMode='linear' repeatCount='indefinite' /%3E%3C/circle%3E%3Ccircle cx='22' cy='22' r='8'%3E%3Canimate attributeName='r' begin='0s' dur='1.5s' values='6;1;2;3;4;5;6' calcMode='linear' repeatCount='indefinite' /%3E%3C/circle%3E%3C/g%3E%3C/svg%3E";

const errorSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' width='256' height='256' viewBox='0 0 256 256' xml:space='preserve'%3E%3Cdefs%3E%3C/defs%3E%3Cg style='stroke: none; stroke-width: 0; stroke-dasharray: none; stroke-linecap: butt; stroke-linejoin: miter; stroke-miterlimit: 10; fill: none; fill-rule: nonzero; opacity: 1;' transform='translate(1.4065934065934016 1.4065934065934016) scale(2.81 2.81)' %3E%3Cpath d='M 85.429 85.078 H 4.571 c -1.832 0 -3.471 -0.947 -4.387 -2.533 c -0.916 -1.586 -0.916 -3.479 0 -5.065 L 40.613 7.455 C 41.529 5.869 43.169 4.922 45 4.922 c 0 0 0 0 0 0 c 1.832 0 3.471 0.947 4.386 2.533 l 40.429 70.025 c 0.916 1.586 0.916 3.479 0.001 5.065 C 88.901 84.131 87.261 85.078 85.429 85.078 z M 45 7.922 c -0.747 0 -1.416 0.386 -1.79 1.033 L 2.782 78.979 c -0.373 0.646 -0.373 1.419 0 2.065 c 0.374 0.647 1.042 1.033 1.789 1.033 h 80.858 c 0.747 0 1.416 -0.387 1.789 -1.033 s 0.373 -1.419 0 -2.065 L 46.789 8.955 C 46.416 8.308 45.747 7.922 45 7.922 L 45 7.922 z M 45 75.325 c -4.105 0 -7.446 -3.34 -7.446 -7.445 s 3.34 -7.445 7.446 -7.445 s 7.445 3.34 7.445 7.445 S 49.106 75.325 45 75.325 z M 45 63.435 c -2.451 0 -4.446 1.994 -4.446 4.445 s 1.995 4.445 4.446 4.445 s 4.445 -1.994 4.445 -4.445 S 47.451 63.435 45 63.435 z M 45 57.146 c -3.794 0 -6.882 -3.087 -6.882 -6.882 V 34.121 c 0 -3.794 3.087 -6.882 6.882 -6.882 c 3.794 0 6.881 3.087 6.881 6.882 v 16.144 C 51.881 54.06 48.794 57.146 45 57.146 z M 45 30.239 c -2.141 0 -3.882 1.741 -3.882 3.882 v 16.144 c 0 2.141 1.741 3.882 3.882 3.882 c 2.14 0 3.881 -1.741 3.881 -3.882 V 34.121 C 48.881 31.98 47.14 30.239 45 30.239 z' style='stroke: none; stroke-width: 1; stroke-dasharray: none; stroke-linecap: butt; stroke-linejoin: miter; stroke-miterlimit: 10; fill: rgb(0,0,0); fill-rule: nonzero; opacity: 1;' transform=' matrix(1 0 0 1 0 0) ' stroke-linecap='round' /%3E%3C/g%3E%3C/svg%3E";

class DeepgramService extends HTMLElement {

  constructor() {
    super();
  }

  configureLanguage() {
    const select = document.querySelector('#language');
    

    populateLanguageDeepgram();

    const selectModel = document.querySelector('#language-model');
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
      //console.log(language)
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
        console.log(blob);

        let player = document.querySelector("#hyperplayer");
        player.src = URL.createObjectURL(blob);
      });
    });
  }

  updateDropdowns(event) {
    let model = document.querySelector('#language-model').value;

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

    let model = document.querySelector('#language-model').value;
    let lang = document.querySelector('#language').value;
    let tiers = deepgramModelCompatibility[lang+"_"+model];

    let options = document.querySelector('#tier').options;
    console.log(options);

    for (let option of options) {
      option.disabled = true;
      if (typeof tiers !== "undefined" && tiers.length > 0 && tiers.includes(option.value)) {
        option.disabled = false;
      }
    };
  }


  getData(event) {
    document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><center>Transcribing....</center><br/><img src="rings.svg" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
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
        //console.log(token);
        fetchData(token, media, tier, language, model);
      } else {
        document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="error.svg" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Please include both a link to the media and token in the form. </center></div>';
      }
    }
  }

  connectedCallback() {
    this.innerHTML = `
    <form id="deepgram-form" name="deepgram-form">
      <div class="flex flex-col gap-4 w-full">
        <label id="close-modal" for="transcribe-modal" class="btn btn-sm btn-circle absolute right-2 top-2">✕</label>
        <h3 class="font-bold text-lg">Transcribe</h3>
        <input id="token" type="text" placeholder="Deepgram token" class="input input-bordered w-full max-w-xs" />
        <hr class="my-2 h-0 border border-t-0 border-solid border-neutral-700 opacity-50 dark:border-neutral-200" />
        <input id="media" type="text" placeholder="Link to media" class="input input-bordered w-full max-w-xs" />
        <span class="label-text">or</span>
        <input id="file" name="file" type="file" class="file-input w-full max-w-xs" />
        <hr class="my-2 h-0 border border-t-0 border-solid border-neutral-700 opacity-50 dark:border-neutral-200" />
        
        <!--<div class="form-control w-48">
          <label class="cursor-pointer label">
            <span class="label-text">Advanced settings</span> 
            <input id="advanced-settings-check" type="checkbox" class="toggle toggle-primary" />
          </label>
        </div>-->

        <span class="label-text">Model</span>
        <div>
          <select id="language-model" name="language-model" placeholder="language-model" class="select select-bordered w-full max-w-xs">
          </select>
        </div>

        <span class="label-text">Language</span>
        <select id="language" name="language" placeholder="language" class="select select-bordered w-full max-w-xs">
        </select>

        <span class="label-text">Quality</span>
        <select id="tier" name="tier" placeholder="tier" class="select select-bordered w-full max-w-xs">
          <option value="base">Base</option>
          <option value="enhanced">Enhanced (Better)</option>
          <option value="nova">Nova (Best)</option>
        </select>


        <!--<div style="padding-top:16px; padding-bottom:16px"><span class="label-text">Tier</span> </div>
        <div class="btn-group">
          <input type="radio" name="options" data-title="base" value="base" class="btn btn-sm" checked />
          <input type="radio" name="options" data-title="enhanced" value="enhanced" class="btn btn-sm" disabled />
          <input type="radio" name="options" data-title="nova" value="nova" class="btn btn-sm" />
        </div>-->
      </div>
      <div class="modal-action">
        <label id="transcribe-btn" for="transcribe-modal" class="btn btn-primary">Transcribe</label>
      </div>
    </form>`;

    document.querySelector('#file').addEventListener('change',this.clearMediaUrl);
    document.querySelector('#media').addEventListener('change',this.clearFilePicker);
    document.querySelector('#transcribe-btn').addEventListener('click', this.getData);
    document.querySelector('#file').addEventListener('change', this.updatePlayerWithLocalFile);
    //document.querySelector('#advanced-settings-check').addEventListener('change', this.toggleAdvancedSettings);
    document.querySelector('#language-model').addEventListener('change', this.updateDropdowns);
    document.querySelector('#language-model').addEventListener('change', this.updateTierDropdown);
    document.querySelector('#language').addEventListener('change', this.updateTierDropdown);


    this.configureLanguage();
  }
}

customElements.define('deepgram-service', DeepgramService);

function fetchData(token, media, tier, language, model) {

  let url = null;
  let languageParam = `&language=${language}`;
  if (language === "xx") {
    //signifies autodetect
    languageParam  = "&detect_language=true";
  }

  if (model.startsWith("whisper")) { // no tier
    url = `https://api.deepgram.com/v1/listen?model=${model}${languageParam}&punctuate=true&diarize=true&summarize=true&detect_topics=true&smart_format=true`
  } else {
    url = `https://api.deepgram.com/v1/listen?model=${model}&tier=${tier}&punctuate=true&diarize=true&summarize=true&detect_topics=true&language=${language}`
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
    parseData(json);
    document.querySelector("#summary").innerHTML = extractSummary(json);
    document.querySelector("#topics").innerHTML = extractTopics(json).join(", ");

    // prepare the VTT track so that the correct language is defined

    if (language === undefined) {
      let detectedLanguage = extractLanguage(json);
      language = detectedLanguage;
      language = detectedLanguage;
    } 

    let track = document.querySelector('#hyperplayer-vtt');
    track.label = language;
    track.srcLang = language;
  })
  .catch(function (error) {
    console.dir("error is : "+error);
    error = error + "";

    if (error.indexOf("401") > 0 || (error.indexOf("400") > 0 && tier === "base")) {
      document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="error.svg" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>It appears that the media URL does not exist<br/> or the token is invalid.</center></div>';
    }
    
    if (error.indexOf("400") > 0 && tier === "enhanced") {
      tier = "base";
      fetchData(token, media, tier, language, model);
    }

    if (error.indexOf("400") > 0 && tier === "nova") {
      tier = "enhanced";
      fetchData(token, media, tier, language, model);
    }

    this.dataError = true;
    document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="error.svg" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>An unexpected error has occurred.</center></div>';
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
    url = `https://api.deepgram.com/v1/listen?model=${model}${languageParam}&punctuate=true&diarize=true&summarize=true&detect_topics=true&smart_format=true`
  } else {
    url = `https://api.deepgram.com/v1/listen?model=${model}&tier=${tier}&punctuate=true&diarize=true&summarize=true&detect_topics=true&language=${language}`
  }
  const apiKey = token;

  // Create a new FileReader instance
  const reader = new FileReader();
  
  reader.readAsArrayBuffer(file);
  let blob = null;

  reader.addEventListener('load', () => {

    file.arrayBuffer().then((arrayBuffer) => {
      blob = new Blob([new Uint8Array(arrayBuffer)], {type: file.type });
      console.log(blob);

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
          parseData(json);
          document.querySelector("#summary").innerHTML = extractSummary(json);
          document.querySelector("#topics").innerHTML = extractTopics(json).join(", ");
        })
        .catch(function (error) {
          console.dir("error is : "+error);
          error = error + "";
      
          if (error.indexOf("401") > 0 || (error.indexOf("400") > 0 && tier === "base")) {
            document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="error.svg" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>It appears that the token is invalid.</center></div>';
          }
          
          if (error.indexOf("400") > 0 && tier === "enhanced") {
            tier = "base";
            fetchDataLocal(token, file, tier, language, model);
          }
      
          this.dataError = true;
          document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="error.svg" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>An unexpected error has occurred.</center></div>';
        })
      } else {
        document.querySelector('#hypertranscript').innerHTML = ''; 
      }
    });
  });
}

function parseData(json) {

  const maxWordsInPara = 100;
  const significantGapInSeconds = 0.5;

  const punctuatedWords = json.results.channels[0].alternatives[0].transcript.split(' ');
  const wordData = json.results.channels[0].alternatives[0].words;

  let hyperTranscript = "<article>\n <section>\n  <p>\n   ";

  let previousElementEnd = 0;
  let wordsInPara = 0;
  let showDiarization = true;

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

  const initEvent = new CustomEvent('hyperaudioInit');
  document.dispatchEvent(initEvent);
  const capEvent = new CustomEvent('hyperaudioGenerateCaptionsFromTranscript');
  document.dispatchEvent(capEvent);
  //const capEditEvent = new CustomEvent('hyperaudioPopulateCaptionEditor');
  //document.dispatchEvent(capEditEvent);
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
    let option = document.createElement("option")
    option.value = optionLanguage[language]
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


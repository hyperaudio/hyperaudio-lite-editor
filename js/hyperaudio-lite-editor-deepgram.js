class DeepgramService extends HTMLElement {

  constructor() {
    super();
  }

  configureLanguage() {
    const select = document.querySelector('#language');
    const optionLanguage = {
      "English": "en",
      "English (United States)": "en-US",
      "English (Great Britain)": "en-GB",
      "Italian": "it",
      "Spanish": "es",
      "Chinese, Simplified Mandarin (China)": "zh-CN",
      "Chinese, Traditional Mandarin (Taiwan)": "zh-TW",
      "Dutch": "nl",
      "English (Australia)": "en-AU",
      "English (India)" : "en-IN",
      "English (New Zealand)" : "en-NZ",
      "French" : "fr",
      "French (Canada)" : "fr-CA",
      "German" : "de",
      "Hindi" : "hi",
      "Hindi (Latin Script)" : "hi-Latn",
      "Indonesian" : "id",
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

    let counter = 0
    Object.keys(optionLanguage).forEach( language => {
      //console.log(language)
      let option = document.createElement("option")
      option.value = optionLanguage[language]
      option.innerHTML = `${language}`
      if (counter === 0) {
        option.selected = "selected"
      }
      select.appendChild(option);
      counter += 1;
    } );

    const selectModel = document.querySelector('#language-model');
    const optionLanguageModel = {
      "General": "general",
      "Whisper (OpenAI)": "whisper",
      "Meeting": "meeting",
      "Phone call": "phonecall",
      "Voicemail": "voicemail",
      "Finance": "finance",
      "Conversational AI": "conversationalai",   
    }

    counter = 0
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

  /*toggleAdvancedSettings(event) {
    if (this.checked === true){
      document.querySelector("#advanced-settings").style.display = "block";
    } else {
      document.querySelector("#advanced-settings").style.display = "none";
    }
  }*/

  getData(event) {
    document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><center>Transcribing....</center><br/><img src="rings.svg" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
    const language = document.querySelector('#language').value;
    const model = document.querySelector('#language-model').value;
    let media =  document.querySelector('#media').value;
    const token =  document.querySelector('#token').value;
    const file = document.querySelector('[name=file]').files[0];
    let tier = "enhanced";

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
        <span class="label-text">Language</span>
        <select id="language" name="language" placeholder="language" class="select select-bordered w-full max-w-xs">
        </select>
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
        <!--<div style="padding-top:16px; padding-bottom:16px"><span class="label-text">Tier</span> </div>
        <div class="btn-group">
          <input type="radio" name="options" data-title="base" value="base" class="btn btn-sm" checked />
          <input type="radio" name="options" data-title="enhanced" value="enhanced" class="btn btn-sm" />
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

    this.configureLanguage();
  }
}

customElements.define('deepgram-service', DeepgramService);

function fetchData(token, media, tier, language, model) {

  let url = null;
  if (model === "whisper") { // no tier
    url = `https://api.deepgram.com/v1/listen?model=whisper&language=${language}&punctuate=true&diarize=true&summarize=true&detect_topics=true&smart_format=true`
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

    this.dataError = true;
    document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><img src="error.svg" width="50" alt="error" style="margin: auto; display: block;"><br/><center>Sorry.<br/>An unexpected error has occurred.</center></div>';
  })
}

function fetchDataLocal(token, file, tier, language, model) {

  //const url = `https://api.deepgram.com/v1/listen?model=general&tier=${tier}&punctuate=true&diarize=true&language=${language}`;

  let url = null;
  if (model === "whisper") { // no tier
    url = `https://api.deepgram.com/v1/listen?model=whisper&language=${language}&punctuate=true&diarize=true&summarize=true&detect_topics=true&smart_format=true`
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

  const event = new CustomEvent('hyperaudioInit');
  document.dispatchEvent(event);
}

function extractSummary(json) {
  let summary = "";
  const summaryData = json.results.channels[0].alternatives[0].summaries;

  console.log(summaryData);

  summaryData.forEach((element, index) => {
    summary += element.summary;
    if (index < summaryData.length - 1) {
      summary += "\n\n";
    }
  });

  return (summary);
}
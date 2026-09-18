/**
 * hyperaudio-lite-editor-deepgram.js
 * (C) The Hyperaudio Project
 * @version 0.6.12 — last changed in release 0.6.12
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
    // #transcript-editor-btn's handler no-ops when already in transcript mode.
    document.querySelector('#transcript-editor-btn')?.click();
    document.querySelector('#hypertranscript').innerHTML = '<div class="vertically-centre"><center>Transcribing....</center><br/><img src="'+transcribingSvg+'" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
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

    // The transcription's media goes on the player BEFORE the busy signal.
    // hyperaudio-save captures what is being transcribed at that signal — the
    // player's media and the File behind it — so that a completion arriving
    // while the user has switched away is filed against the right project. A
    // URL set afterwards was too late: the capture took the OUTGOING project's
    // media, named the new project after it, and put its src back on the
    // player when the transcript landed.
    // A local file is already on the player: the file picker's own change
    // handler put it there when the file was chosen.
    if (file !== undefined) {
      if (typeof setTranscriptBusy === 'function') {
        setTranscriptBusy(true);
      }
      fetchDataLocal(token, file, language, model);
      document.querySelector('#deepgram-media').value = "";
    } else {
      if (media !== "" || token !== "") {
        let player = document.querySelector("#hyperplayer");
        player.src = media;
        if (typeof setTranscriptBusy === 'function') {
          setTranscriptBusy(true);
        }
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

// Deepgram's own speaker flags around each change, against the words as they
// were spoken: a label that looks mid-sentence is either theirs, in which case
// the flag really does flip there, or ours, in which case it does not. Prints
// the words either side, the gap before each, and whether the flip lasts.
// hyperaudioSpeakerDebug() in the console after a Deepgram transcription.
window.hyperaudioSpeakerDebug = function hyperaudioSpeakerDebug(limit) {
  const json = window.hyperaudioLastDeepgram;
  if (!json) {
    console.log('No Deepgram response this session — transcribe again, then run this.');
    return null;
  }
  const words = json.results.channels[0].alternatives[0].words || [];
  const textOf = (w) => (typeof w.punctuated_word === 'string' && w.punctuated_word !== '' ? w.punctuated_word : w.word);
  const gap = (i) => (i === 0 ? 0 : Number((words[i].start - words[i - 1].end).toFixed(2)));
  // how many words this speaker holds before the next change
  const runFrom = (i) => {
    let n = 0;
    while (i + n < words.length && words[i + n].speaker === words[i].speaker) n += 1;
    return n;
  };
  const changes = [];
  for (let i = 1; i < words.length; i += 1) {
    if (words[i].speaker !== words[i - 1].speaker) changes.push(i);
  }
  const lines = changes.slice(0, limit || 12).map((i) => {
    const before = words.slice(Math.max(0, i - 5), i).map(textOf).join(' ');
    const after = words.slice(i, i + 5).map(textOf).join(' ');
    const endsSentence = /[.?!]$/.test(textOf(words[i - 1]) || '');
    return '  ...' + before + '  [speaker-' + words[i].speaker + ']  ' + after + '...'
      + '\n     gap ' + gap(i) + 's | prev ends sentence: ' + endsSentence
      + ' | this speaker holds ' + runFrom(i) + ' word(s)';
  });
  const report = {
    changesSnappedToUtterances: !!(json.results && json.results.utterances),
    utterances: ((json.results && json.results.utterances) || []).length || 0,
    words: words.length,
    speakers: [...new Set(words.map((w) => w.speaker))].sort(),
    changes: changes.length,
    changesMidSentence: changes.filter((i) => !/[.?!]$/.test(textOf(words[i - 1]) || '')).length,
    oneWordTurns: changes.filter((i) => runFrom(i) === 1).length,
    model: (json.metadata && json.metadata.models) || null,
  };
  console.log(JSON.stringify(report, null, 1));
  console.log(lines.join('\n'));
  return report;
};

function getApiUrl(language, model) {
  const languageParam = (language === "xx") ? "&detect_language=true" : `&language=${language}`;
  // utterances: speaker-tagged segments, cut on pauses and turns, which is
  // what makes a speaker label land at the start of what someone said rather
  // than a few words into it (see applySpeakersFromUtterances)
  return `https://api.deepgram.com/v1/listen?model=${model}${languageParam}&diarize=true&utterances=true&summarize=v2&topics=true&smart_format=true`;
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

  const wordData = json.results.channels[0].alternatives[0].words;
  // Kept for hyperaudioSpeakerDebug(): where a speaker label looks wrong, the
  // question is whether Deepgram said the speaker changed there, and only
  // their own flags answer it.
  window.hyperaudioLastDeepgram = json;
  // The visible text comes off each word, beside that word's own timing and
  // speaker. It used to come from a SECOND list — the formatted transcript
  // split on spaces — matched to the word array by position alone, with
  // nothing checking the two were the same length. smart_format is exactly
  // what breaks that: it rewrites spoken numbers and the like into forms with
  // a different token count, and from the first mismatch every word after it
  // is drawn from the wrong slot, so labels land against the wrong text. The
  // formatted word is already on the object smart_format put it there for.
  const textOf = (w) => (typeof w.punctuated_word === 'string' && w.punctuated_word !== ''
    ? w.punctuated_word : w.word);
  console.log("wordData...");
  console.log(wordData);

  // Deepgram's `diarize` tags every word on its own, with no regard for what
  // was being said, so a boundary lands a few words short of where the turn
  // actually ended and the next speaker is credited with the tail of the
  // previous one's sentence — the label then reads as mid-sentence.
  //
  // `utterances` gives segments cut on pauses and turns. Taking each word's
  // speaker from the utterance it falls in was tried and was worse: on a
  // six-way debate with heavy crosstalk their segments run straight through
  // speaker changes, so 374 words moved and whole turns merged — the host
  // swallowed into the previous answer. Their segmentation is coarser than
  // their own per-word flags, and trusting it loses distinctions the flags
  // had.
  //
  // What the segments are good for is WHERE, not WHO. Every word-level change
  // is kept, exactly as many as before, and each is nudged onto the nearest
  // utterance edge within a few seconds — an edge being a pause or a turn, so
  // the label lands at the start of what someone said rather than four words
  // in. A change with no edge near it is left alone, and no change may cross
  // its neighbours, so this can move a boundary but never remove one and
  // never merge two speakers.
  function snapChangesToUtterances(words, utterances) {
    if (!Array.isArray(utterances) || utterances.length === 0) return 0;
    const edges = utterances
      .filter((u) => u && Number.isFinite(u.start))
      .map((u) => u.start)
      .sort((a, b) => a - b);
    if (edges.length === 0) return 0;

    const changes = [];
    for (let i = 1; i < words.length; i += 1) {
      if (words[i].speaker !== words[i - 1].speaker) changes.push(i);
    }

    const WINDOW_SECONDS = 3;
    let moved = 0;
    let floor = 1;                 // no change may move at or before the last one
    changes.forEach((at, n) => {
      const ceiling = n + 1 < changes.length ? changes[n + 1] : words.length;
      const t = words[at].start;
      if (!Number.isFinite(t)) { floor = at + 1; return; }
      let edge = null;
      for (let e = 0; e < edges.length; e += 1) {
        const d = Math.abs(edges[e] - t);
        if (d > WINDOW_SECONDS) continue;
        if (edge === null || d < Math.abs(edge - t)) edge = edges[e];
      }
      if (edge === null) { floor = at + 1; return; }
      let to = at;
      if (edge > t) {
        while (to < ceiling && words[to].start < edge - 0.001) to += 1;
      } else {
        while (to > floor && words[to - 1].start >= edge - 0.001) to -= 1;
      }
      if (to === at || to <= floor - 1 || to >= ceiling) { floor = at + 1; return; }
      const before = words[at - 1].speaker;
      const after = words[at].speaker;
      if (to > at) {
        for (let i = at; i < to; i += 1) words[i].speaker = before;   // the tail goes back
      } else {
        for (let i = to; i < at; i += 1) words[i].speaker = after;    // the head comes forward
      }
      moved += 1;
      floor = to + 1;
    });
    return moved;
  }
  const utterances = (json.results && json.results.utterances) || json.utterances || null;
  const snapped = snapChangesToUtterances(wordData, utterances);
  console.log(utterances === null
    ? 'Deepgram: no utterances in the response — speaker changes left where they fell'
    : `Deepgram: ${snapped} speaker change(s) moved onto an utterance edge, of ${utterances.length} utterances`);

  // Fix Deepgram diarization edge case where the last word of a speaker turn
  // gets attached to the next speaker. Signature: the word starts essentially
  // on top of the previous speaker's word, but the next word from this "new"
  // speaker is far away. In that case, reassign the word back. The same fault
  // as the snap above addresses, patched a word at a time, and it still earns
  // its place where a response carries no utterances.
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

    let currentWord = textOf(element);
    wordsInPara++;

    // if there's a gap longer than half a second consider splitting into new para

    if (previousElementEnd !== 0 && (element.start - previousElementEnd) > significantGapInSeconds || wordsInPara > maxWordsInPara){
      let previousWord = textOf(wordData[index-1]);
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

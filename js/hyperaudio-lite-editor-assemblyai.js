/**
 * hyperaudio-lite-editor-assemblyai.js
 * (C) The Hyperaudio Project
 * @version 0.8.1 — last changed in release 0.8.1
 * @license MIT
 *
 * AssemblyAI (Cloud) transcription — called directly from the browser with the
 * user's own API key, no backend (#390). AssemblyAI's REST API is CORS-open
 * (Access-Control-Allow-Origin: *), so `fetch` from the page works. Unlike
 * Deepgram's single synchronous call, the flow is async:
 *   1. upload the file  -> upload_url   (skipped when a public URL is supplied)
 *   2. POST /transcript -> transcript id
 *   3. poll  /transcript/{id} until status is completed / error
 *
 * The completed transcript's word list (start/end in MILLISECONDS) is parsed
 * into the same data-m / data-d spans the other engines emit. Reuses the global
 * helpers transcribingSvg / errorSvg (editor-svg.js) and setTranscriptBusy /
 * setTranscriptionInfo (editor-core.js).
 */

const ASSEMBLYAI_BASE = "https://api.assemblyai.com/v2";
const ASSEMBLYAI_POLL_MS = 3000;
const assemblyaiSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ASSEMBLYAI_MODELS = [
  { value: "best", label: "Best (most accurate)" },
  { value: "nano", label: "Nano (fast, more languages)" },
];

const ASSEMBLYAI_LANGUAGES = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "hi", label: "Hindi" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
  { value: "ko", label: "Korean" },
  { value: "ru", label: "Russian" },
  { value: "uk", label: "Ukrainian" },
  { value: "tr", label: "Turkish" },
];

let assemblyaiTranscriptionStart = 0;
let assemblyaiTranscriptionMeta = {};

class AssemblyAIService extends HTMLElement {
  constructor() {
    super();
  }

  clearMediaUrl(event) {
    event.preventDefault();
    document.querySelector('#assemblyai-media').value = "";
  }

  clearFilePicker(event) {
    event.preventDefault();
    document.querySelector('#assemblyai-file').value = "";
  }

  updatePlayerWithLocalFile() {
    const file = document.querySelector('#assemblyai-file').files[0];
    if (!file) return;
    document.querySelector("#hyperplayer").src = URL.createObjectURL(file);
  }

  getData() {
    // If in caption mode, switch back to transcript view so the loader shows and
    // the result lands in the right place (#transcript-editor-btn no-ops when
    // already in transcript mode).
    document.querySelector('#transcript-editor-btn')?.click();
    document.querySelector('#hypertranscript').innerHTML =
      '<div class="vertically-centre"><center>Transcribing….</center><br/><img src="' + transcribingSvg + '" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
    if (typeof setTranscriptBusy === 'function') {
      setTranscriptBusy(true);
    }

    const apiKey = document.querySelector('#assemblyai-key').value.trim();
    const language = document.querySelector('#assemblyai-language').value;
    const model = document.querySelector('#assemblyai-model').value;
    let media = document.querySelector('#assemblyai-media').value.trim();
    const file = document.querySelector('#assemblyai-file').files[0];

    if (apiKey === "" || (file === undefined && media === "")) {
      document.querySelector('#hypertranscript').innerHTML =
        assemblyaiErrorHtml("Please provide your AssemblyAI API key and either a media link or a file.");
      if (typeof setTranscriptBusy === 'function') {
        setTranscriptBusy(false);
      }
      return;
    }

    if (file === undefined && !/^https?:\/\//i.test(media)) {
      media = "https://" + media;
    }

    assemblyaiTranscriptionStart = Date.now();
    assemblyaiTranscriptionMeta = {
      service: "AssemblyAI (cloud)",
      model: document.querySelector('#assemblyai-model').selectedOptions[0]?.textContent || model,
      language: document.querySelector('#assemblyai-language').selectedOptions[0]?.textContent || language,
    };

    // point the player at the media now so click-to-seek works after transcribing
    const player = document.querySelector("#hyperplayer");
    if (file !== undefined) {
      player.src = URL.createObjectURL(file);
    } else {
      player.src = media;
      document.querySelector('#assemblyai-media').value = "";
    }

    runAssemblyAI(apiKey, file, media, { language, model }).catch(displayAssemblyAIError);
  }

  connectedCallback() {
    const templateSelector = this.getAttribute("templateSelector");
    if (templateSelector === null || document.querySelector(templateSelector) === null) {
      return;
    }
    this.innerHTML = document.querySelector(templateSelector).innerHTML;
    document.querySelector(templateSelector).remove();
    this.configureOptions();
    addAssemblyAIListeners(this);
  }

  configureOptions() {
    const modelSel = this.querySelector('#assemblyai-model');
    ASSEMBLYAI_MODELS.forEach((m, i) => {
      const o = document.createElement('option');
      o.value = m.value;
      o.textContent = m.label;
      if (i === 0) o.selected = true;
      modelSel.appendChild(o);
    });
    const langSel = this.querySelector('#assemblyai-language');
    ASSEMBLYAI_LANGUAGES.forEach((l, i) => {
      const o = document.createElement('option');
      o.value = l.value;
      o.textContent = l.label;
      if (i === 0) o.selected = true;
      langSel.appendChild(o);
    });
  }
}
customElements.define('assemblyai-service', AssemblyAIService);

function addAssemblyAIListeners(el) {
  document.querySelector('#assemblyai-file').addEventListener('change', el.clearMediaUrl);
  document.querySelector('#assemblyai-media').addEventListener('change', el.clearFilePicker);
  document.querySelector('#assemblyai-file').addEventListener('change', el.updatePlayerWithLocalFile);

  document.querySelector('#assemblyai-submit-btn').addEventListener('click', (event) => {
    if (document.querySelector('#assemblyai-submit-btn').classList.contains('btn-disabled')) {
      event.preventDefault();
      return;
    }
    el.getData();
  });

  // Enable TRANSCRIBE only once there's a key AND a file or media link.
  const updateState = () => {
    const hasFile = document.querySelector('#assemblyai-file').files.length > 0;
    const hasMedia = document.querySelector('#assemblyai-media').value.trim() !== '';
    const hasKey = document.querySelector('#assemblyai-key').value.trim() !== '';
    const button = document.querySelector('#assemblyai-submit-btn');
    if (hasKey && (hasFile || hasMedia)) {
      button.classList.remove('btn-disabled');
      button.setAttribute('aria-disabled', 'false');
    } else {
      button.classList.add('btn-disabled');
      button.setAttribute('aria-disabled', 'true');
    }
  };
  document.querySelector('#assemblyai-file').addEventListener('change', updateState);
  document.querySelector('#assemblyai-media').addEventListener('input', updateState);
  document.querySelector('#assemblyai-key').addEventListener('input', updateState);
}

// upload (if a file) -> submit -> poll to completion
async function runAssemblyAI(apiKey, file, media, opts) {
  let audioUrl = media;

  if (file !== undefined) {
    setAssemblyAIStatus("Uploading…");
    const up = await fetch(`${ASSEMBLYAI_BASE}/upload`, {
      method: 'POST',
      headers: { 'Authorization': apiKey },
      body: file,
    });
    if (!up.ok) throw new Error(up.status);
    audioUrl = (await up.json()).upload_url;
  }

  setAssemblyAIStatus("Submitting…");
  const params = {
    audio_url: audioUrl,
    speech_model: opts.model,
    speaker_labels: true,
  };
  if (opts.language === "auto") {
    params.language_detection = true;
  } else {
    params.language_code = opts.language;
  }

  const submit = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
    method: 'POST',
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!submit.ok) throw new Error(submit.status);
  const id = (await submit.json()).id;

  for (;;) {
    await assemblyaiSleep(ASSEMBLYAI_POLL_MS);
    const poll = await fetch(`${ASSEMBLYAI_BASE}/transcript/${id}`, {
      headers: { 'Authorization': apiKey },
    });
    if (!poll.ok) throw new Error(poll.status);
    const json = await poll.json();
    if (json.status === 'completed') {
      if (!json.words || json.words.length === 0) {
        displayAssemblyAINoWords();
        return;
      }
      assemblyaiParseData(json);
      return;
    }
    if (json.status === 'error') {
      throw new Error(json.error || 'transcription error');
    }
    setAssemblyAIStatus("Transcribing…");
  }
}

function setAssemblyAIStatus(text) {
  const el = document.querySelector('#hypertranscript .vertically-centre center');
  if (el) el.textContent = text;
}

// Build the transcript HTML from AssemblyAI's word list (start/end in ms) — the
// same data-m / data-d span shape the other engines produce.
function assemblyaiParseData(json) {
  const maxWordsInPara = 100;
  const significantGapInSeconds = 4.0;
  const words = json.words;
  const showDiarization = words.some((w) => w.speaker !== null && w.speaker !== undefined);

  let hyperTranscript = "<article>\n <section>\n  <p>\n   ";
  let previousEndSec = 0;
  let wordsInPara = 0;

  const language = json.language_code || (document.querySelector('#assemblyai-language') || {}).value || "";
  const track = document.querySelector('#hyperplayer-vtt');
  if (track) {
    track.label = language;
    track.srcLang = language;
  }

  words.forEach((element, index) => {
    const startSec = element.start / 1000;
    const endSec = element.end / 1000;
    wordsInPara++;

    // paragraph break on a long gap (only after sentence-final punctuation) or
    // when a paragraph gets too long
    if ((previousEndSec !== 0 && (startSec - previousEndSec) > significantGapInSeconds) || wordsInPara > maxWordsInPara) {
      const prevWord = (words[index - 1] && words[index - 1].text) || "";
      const lastChar = prevWord.charAt(prevWord.length - 1);
      if (lastChar === "." || lastChar === "?" || lastChar === "!") {
        hyperTranscript += "\n  </p>\n  <p>\n   ";
        wordsInPara = 0;
      }
    }

    // new paragraph + speaker label on speaker change (or the first word)
    if ((showDiarization && index > 0 && element.speaker !== words[index - 1].speaker) || index === 0) {
      if (index > 0) {
        hyperTranscript += "\n  </p>\n  <p>\n   ";
        wordsInPara = 0;
      }
      if (showDiarization) {
        hyperTranscript += `<span class="speaker" data-m='${element.start}' data-d='0'>[speaker-${element.speaker}] </span>`;
      }
    }

    hyperTranscript += `<span data-m='${element.start}' data-d='${element.end - element.start}'>${element.text} </span>`;
    previousEndSec = endSec;
  });

  hyperTranscript += "\n </p> \n </section>\n</article>\n ";
  hyperTranscript = hyperTranscript.replace(/<p>\s*<\/p>\s*/g, '');

  document.querySelector("#hypertranscript").innerHTML = hyperTranscript;

  const showSpeakers = document.querySelector('#show-speakers');
  document.querySelectorAll('.speaker').forEach((speaker) => {
    speaker.style.display = (showSpeakers && showSpeakers.checked) ? "inline" : "none";
  });

  document.querySelector('#download-html').setAttribute('href', 'data:text/html,' + encodeURIComponent(hyperTranscript));

  if (typeof setTranscriptionInfo === 'function' && assemblyaiTranscriptionStart !== 0) {
    setTranscriptionInfo({ ...assemblyaiTranscriptionMeta, seconds: (Date.now() - assemblyaiTranscriptionStart) / 1000 });
  }
  if (typeof setTranscriptBusy === 'function') {
    setTranscriptBusy(false);
  }

  document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
}

function assemblyaiErrorHtml(message) {
  return '<div class="vertically-centre"><img src="' + errorSvg + '" width="50" alt="error" style="margin: auto; display: block;"><br/><center>' + message + '</center></div>';
}

function displayAssemblyAIError(error) {
  if (typeof setTranscriptBusy === 'function') {
    setTranscriptBusy(false);
  }
  const e = "" + (error && error.message ? error.message : error);
  let msg = "Sorry.<br/>An unexpected error has occurred.";
  if (e.indexOf("401") >= 0 || e.indexOf("403") >= 0) {
    msg = "Sorry.<br/>The API key appears to be invalid.";
  } else if (e.indexOf("400") >= 0 || e.indexOf("422") >= 0) {
    msg = "Sorry.<br/>The media could not be read — check the file or URL.";
  }
  document.querySelector('#hypertranscript').innerHTML = assemblyaiErrorHtml(msg);
  console.error("AssemblyAI error:", error);
}

function displayAssemblyAINoWords() {
  if (typeof setTranscriptBusy === 'function') {
    setTranscriptBusy(false);
  }
  document.querySelector('#hypertranscript').innerHTML =
    assemblyaiErrorHtml("Sorry.<br/>No words were detected.<br/>Please verify that the audio contains speech.");
}

/**
 * hyperaudio-lite-editor-parakeet.js
 * (C) The Hyperaudio Project
 * @version 0.8.2 — last changed in release 0.8.2
 * @license MIT
 *
 * Parakeet (HuggingFace) cloud transcription (#307) — NVIDIA Parakeet TDT 0.6B
 * v3 served through HuggingFace's inference router, called directly from the
 * browser with the user's own HF token (no server; the router endpoint is
 * CORS-open). Unlike AssemblyAI's async upload→poll, this is a single
 * synchronous multipart POST (like Deepgram):
 *
 *   POST router.huggingface.co/together/v1/audio/transcriptions
 *     model=nvidia/parakeet-tdt-0.6b-v3, file=<audio>,
 *     response_format=verbose_json, timestamp_granularities[]=word
 *
 * Response (verified): { language, duration, text, words:[{word,start,end}] }
 * with start/end in SECONDS. Parsed into the same data-m/data-d spans the other
 * engines emit; no speaker labels (Parakeet doesn't diarize). Reuses the global
 * helpers transcribingSvg / errorSvg and setTranscriptBusy / setTranscriptionInfo.
 */

const PARAKEET_HF_ENDPOINT = "https://router.huggingface.co/together/v1/audio/transcriptions";
const PARAKEET_HF_MODEL = "nvidia/parakeet-tdt-0.6b-v3";

// Parakeet TDT 0.6B v3 — 25 European languages. "auto" omits the language field
// (the endpoint auto-detects, verified).
const PARAKEET_HF_LANGUAGES = [
  { value: "auto", label: "Auto-detect" },
  { value: "bg", label: "Bulgarian" },
  { value: "hr", label: "Croatian" },
  { value: "cs", label: "Czech" },
  { value: "da", label: "Danish" },
  { value: "nl", label: "Dutch" },
  { value: "en", label: "English" },
  { value: "et", label: "Estonian" },
  { value: "fi", label: "Finnish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "el", label: "Greek" },
  { value: "hu", label: "Hungarian" },
  { value: "it", label: "Italian" },
  { value: "lv", label: "Latvian" },
  { value: "lt", label: "Lithuanian" },
  { value: "mt", label: "Maltese" },
  { value: "pl", label: "Polish" },
  { value: "pt", label: "Portuguese" },
  { value: "ro", label: "Romanian" },
  { value: "ru", label: "Russian" },
  { value: "sk", label: "Slovak" },
  { value: "sl", label: "Slovenian" },
  { value: "es", label: "Spanish" },
  { value: "sv", label: "Swedish" },
  { value: "uk", label: "Ukrainian" },
];

let parakeetHfTranscriptionStart = 0;
let parakeetHfTranscriptionMeta = {};

class ParakeetHFService extends HTMLElement {
  constructor() {
    super();
  }

  clearMediaUrl(event) {
    event.preventDefault();
    document.querySelector('#parakeet-hf-media').value = "";
  }

  clearFilePicker(event) {
    event.preventDefault();
    document.querySelector('#parakeet-hf-file').value = "";
  }

  updatePlayerWithLocalFile() {
    const file = document.querySelector('#parakeet-hf-file').files[0];
    if (!file) return;
    document.querySelector("#hyperplayer").src = URL.createObjectURL(file);
  }

  getData() {
    document.querySelector('#transcript-editor-btn')?.click();
    document.querySelector('#hypertranscript').innerHTML =
      '<div class="vertically-centre"><center>Transcribing….</center><br/><img src="' + transcribingSvg + '" width="50" alt="transcribing" style="margin: auto; display: block;"></div>';
    if (typeof setTranscriptBusy === 'function') {
      setTranscriptBusy(true);
    }

    const apiKey = document.querySelector('#parakeet-hf-key').value.trim();
    const language = document.querySelector('#parakeet-hf-language').value;
    let media = document.querySelector('#parakeet-hf-media').value.trim();
    const file = document.querySelector('#parakeet-hf-file').files[0];

    if (apiKey === "" || (file === undefined && media === "")) {
      document.querySelector('#hypertranscript').innerHTML =
        parakeetHfErrorHtml("Please provide your HuggingFace token and either a media link or a file.");
      if (typeof setTranscriptBusy === 'function') {
        setTranscriptBusy(false);
      }
      return;
    }

    if (file === undefined && !/^https?:\/\//i.test(media)) {
      media = "https://" + media;
    }

    parakeetHfTranscriptionStart = Date.now();
    parakeetHfTranscriptionMeta = {
      service: "Parakeet (HuggingFace, cloud)",
      model: "Parakeet TDT 0.6B v3",
      language: document.querySelector('#parakeet-hf-language').selectedOptions[0]?.textContent || language,
    };

    const player = document.querySelector("#hyperplayer");
    if (file !== undefined) {
      player.src = URL.createObjectURL(file);
    } else {
      player.src = media;
      document.querySelector('#parakeet-hf-media').value = "";
    }

    runParakeetHF(apiKey, file, media, { language }).catch(displayParakeetHfError);
  }

  connectedCallback() {
    const templateSelector = this.getAttribute("templateSelector");
    if (templateSelector === null || document.querySelector(templateSelector) === null) {
      return;
    }
    this.innerHTML = document.querySelector(templateSelector).innerHTML;
    document.querySelector(templateSelector).remove();
    this.configureOptions();
    addParakeetHFListeners(this);
  }

  configureOptions() {
    const langSel = this.querySelector('#parakeet-hf-language');
    PARAKEET_HF_LANGUAGES.forEach((l, i) => {
      const o = document.createElement('option');
      o.value = l.value;
      o.textContent = l.label;
      if (i === 0) o.selected = true;
      langSel.appendChild(o);
    });
  }
}
customElements.define('parakeet-hf-service', ParakeetHFService);

function addParakeetHFListeners(el) {
  document.querySelector('#parakeet-hf-file').addEventListener('change', el.clearMediaUrl);
  document.querySelector('#parakeet-hf-media').addEventListener('change', el.clearFilePicker);
  document.querySelector('#parakeet-hf-file').addEventListener('change', el.updatePlayerWithLocalFile);

  document.querySelector('#parakeet-hf-submit-btn').addEventListener('click', (event) => {
    if (document.querySelector('#parakeet-hf-submit-btn').classList.contains('btn-disabled')) {
      event.preventDefault();
      return;
    }
    el.getData();
  });

  const updateState = () => {
    const hasFile = document.querySelector('#parakeet-hf-file').files.length > 0;
    const hasMedia = document.querySelector('#parakeet-hf-media').value.trim() !== '';
    const hasKey = document.querySelector('#parakeet-hf-key').value.trim() !== '';
    const button = document.querySelector('#parakeet-hf-submit-btn');
    if (hasKey && (hasFile || hasMedia)) {
      button.classList.remove('btn-disabled');
      button.setAttribute('aria-disabled', 'false');
    } else {
      button.classList.add('btn-disabled');
      button.setAttribute('aria-disabled', 'true');
    }
  };
  document.querySelector('#parakeet-hf-file').addEventListener('change', updateState);
  document.querySelector('#parakeet-hf-media').addEventListener('input', updateState);
  document.querySelector('#parakeet-hf-key').addEventListener('input', updateState);
}

// Single synchronous multipart POST. For a URL the media is fetched client-side
// and forwarded as a Blob (the endpoint takes a file, not a URL), so a
// cross-origin media host without CORS will fail here with a clear message.
async function runParakeetHF(apiKey, file, media, opts) {
  let blob = file;
  let filename = file ? file.name : 'audio';
  if (!blob) {
    let mediaResp;
    try {
      mediaResp = await fetch(media);
      if (!mediaResp.ok) throw new Error('media ' + mediaResp.status);
    } catch (e) {
      throw new Error('media-fetch');
    }
    blob = await mediaResp.blob();
    filename = media.split('/').pop() || 'audio';
  }

  const form = new FormData();
  form.append('model', PARAKEET_HF_MODEL);
  form.append('file', blob, filename);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  if (opts.language && opts.language !== 'auto') {
    form.append('language', opts.language);
  }

  const resp = await fetch(PARAKEET_HF_ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    body: form,
  });
  if (!resp.ok) throw new Error(resp.status);

  const json = await resp.json();
  if (!json.words || json.words.length === 0) {
    displayParakeetHfNoWords();
    return;
  }
  parakeetHfParseData(json);
}

// Build transcript HTML from the word list (start/end in SECONDS). No speaker
// labels — Parakeet doesn't diarize.
function parakeetHfParseData(json) {
  const maxWordsInPara = 100;
  const significantGapInSeconds = 4.0;
  const words = json.words;

  let hyperTranscript = "<article>\n <section>\n  <p>\n   ";
  let previousEndSec = 0;
  let wordsInPara = 0;

  const language = json.language || "";
  const track = document.querySelector('#hyperplayer-vtt');
  if (track) {
    track.label = language;
    track.srcLang = language;
  }

  words.forEach((element, index) => {
    const startMs = Math.round(element.start * 1000);
    const durMs = Math.round((element.end - element.start) * 1000);
    wordsInPara++;

    if ((previousEndSec !== 0 && (element.start - previousEndSec) > significantGapInSeconds) || wordsInPara > maxWordsInPara) {
      const prevWord = (words[index - 1] && words[index - 1].word) || "";
      const lastChar = prevWord.charAt(prevWord.length - 1);
      if (lastChar === "." || lastChar === "?" || lastChar === "!") {
        hyperTranscript += "\n  </p>\n  <p>\n   ";
        wordsInPara = 0;
      }
    }

    hyperTranscript += `<span data-m='${startMs}' data-d='${durMs}'>${element.word} </span>`;
    previousEndSec = element.end;
  });

  hyperTranscript += "\n </p> \n </section>\n</article>\n ";
  hyperTranscript = hyperTranscript.replace(/<p>\s*<\/p>\s*/g, '');

  document.querySelector("#hypertranscript").innerHTML = hyperTranscript;
  document.querySelector('#download-html').setAttribute('href', 'data:text/html,' + encodeURIComponent(hyperTranscript));

  if (typeof setTranscriptionInfo === 'function' && parakeetHfTranscriptionStart !== 0) {
    setTranscriptionInfo({ ...parakeetHfTranscriptionMeta, seconds: (Date.now() - parakeetHfTranscriptionStart) / 1000 });
  }
  if (typeof setTranscriptBusy === 'function') {
    setTranscriptBusy(false);
  }

  document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
}

function parakeetHfErrorHtml(message) {
  return '<div class="vertically-centre"><img src="' + errorSvg + '" width="50" alt="error" style="margin: auto; display: block;"><br/><center>' + message + '</center></div>';
}

function displayParakeetHfError(error) {
  if (typeof setTranscriptBusy === 'function') {
    setTranscriptBusy(false);
  }
  const e = "" + (error && error.message ? error.message : error);
  let msg = "Sorry.<br/>An unexpected error has occurred.";
  if (e.indexOf("media-fetch") >= 0) {
    msg = "Sorry.<br/>Couldn't fetch that media URL from the browser (it may block cross-origin requests). Try uploading the file instead.";
  } else if (e.indexOf("401") >= 0 || e.indexOf("403") >= 0) {
    msg = "Sorry.<br/>The HuggingFace token appears to be invalid.";
  } else if (e.indexOf("402") >= 0) {
    msg = "Sorry.<br/>Your HuggingFace inference quota is exhausted. Add a paid plan or try another provider.";
  } else if (e.indexOf("400") >= 0 || e.indexOf("422") >= 0) {
    msg = "Sorry.<br/>The request was rejected — the media may be unreadable or the model unavailable.";
  } else if (e.indexOf("503") >= 0 || e.indexOf("500") >= 0) {
    msg = "Sorry.<br/>HuggingFace inference is unavailable right now — try again shortly.";
  }
  document.querySelector('#hypertranscript').innerHTML = parakeetHfErrorHtml(msg);
  console.error("Parakeet (HF) error:", error);
}

function displayParakeetHfNoWords() {
  if (typeof setTranscriptBusy === 'function') {
    setTranscriptBusy(false);
  }
  document.querySelector('#hypertranscript').innerHTML =
    parakeetHfErrorHtml("Sorry.<br/>No words were detected.<br/>Please verify that the audio contains speech.");
}

/**
 * hyperaudio-lite-editor-parakeet.js
 * (C) The Hyperaudio Project
 * @version 1.3.45 — last changed in release 1.3.45
 * @license AGPL-3.0-only
 *
 * Nemotron (Hugging Face) cloud transcription (#307, #777) — NVIDIA Nemotron
 * 3.5 ASR 0.6B served through Hugging Face's inference router by Together,
 * called directly from the browser with the user's own token (no server; the
 * router endpoint is CORS-open). The engine began as Parakeet TDT 0.6B v3 on
 * the same route; Together withdrew that model from Inference Providers and
 * the router answered 410 for it (#777), so the model is now its successor.
 * The element, the ids and this file keep their names: the remembered token
 * and the lists that name the inputs are keyed on them. Unlike AssemblyAI's async upload→poll, this is a single
 * synchronous multipart POST (like Deepgram):
 *
 *   POST router.huggingface.co/together/v1/audio/transcriptions
 *     model=nvidia/nemotron-3.5-asr-streaming-0.6b, file=<audio>,
 *     response_format=verbose_json, timestamp_granularities[]=word
 *
 * Response: { language, duration, text, words:[{word,start,end}] } with
 * start/end in SECONDS (verified for Parakeet on this route, the same
 * OpenAI-style form for every model Together serves there). Parsed into the
 * same data-m/data-d spans the other engines emit; no speaker labels. Reuses the global
 * helpers transcribingSvg / errorSvg and setTranscriptBusy / setTranscriptionInfo.
 */

const PARAKEET_HF_ENDPOINT = "https://router.huggingface.co/together/v1/audio/transcriptions";
const PARAKEET_HF_MODEL = "nvidia/nemotron-3.5-asr-streaming-0.6b";

// Nemotron 3.5 ASR 0.6B transcribes 32 locales out of the box. One entry per
// language, ISO 639-1 codes as the route takes them. "auto" omits the field
// and the model detects the language.
const PARAKEET_HF_LANGUAGES = [
  { value: "auto", label: "Auto-detect" },
  { value: "ar", label: "Arabic" },
  { value: "bg", label: "Bulgarian" },
  { value: "zh", label: "Chinese (Mandarin)" },
  { value: "hr", label: "Croatian" },
  { value: "cs", label: "Czech" },
  { value: "da", label: "Danish" },
  { value: "nl", label: "Dutch" },
  { value: "en", label: "English" },
  { value: "et", label: "Estonian" },
  { value: "fi", label: "Finnish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "hi", label: "Hindi" },
  { value: "hu", label: "Hungarian" },
  { value: "it", label: "Italian" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "nb", label: "Norwegian (Bokmål)" },
  { value: "pl", label: "Polish" },
  { value: "pt", label: "Portuguese" },
  { value: "ro", label: "Romanian" },
  { value: "ru", label: "Russian" },
  { value: "sk", label: "Slovak" },
  { value: "es", label: "Spanish" },
  { value: "sv", label: "Swedish" },
  { value: "tr", label: "Turkish" },
  { value: "uk", label: "Ukrainian" },
  { value: "vi", label: "Vietnamese" },
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

    const apiKey = document.querySelector('#parakeet-hf-key').value.trim();
    const language = document.querySelector('#parakeet-hf-language').value;
    let media = document.querySelector('#parakeet-hf-media').value.trim();
    const file = document.querySelector('#parakeet-hf-file').files[0];

    if (apiKey === "" || (file === undefined && media === "")) {
      if (typeof setTranscriptBusy === 'function') {
        setTranscriptBusy(false);
      }
      showParakeetHfError("Please provide your Hugging Face token and either a media link or a file.");
      return;
    }

    if (file === undefined && !/^https?:\/\//i.test(media)) {
      media = "https://" + media;
    }

    parakeetHfTranscriptionStart = Date.now();
    parakeetHfTranscriptionMeta = {
      service: "Nemotron (Hugging Face, cloud)",
      model: "Nemotron 3.5 ASR 0.6B",
      language: document.querySelector('#parakeet-hf-language').selectedOptions[0]?.textContent || language,
      languageCode: language,
      // what was really asked for (#668)
      modelId: PARAKEET_HF_MODEL,
      parameters: Object.assign({ model: PARAKEET_HF_MODEL, response_format: 'verbose_json', timestamp_granularities: ['word'] },
        language ? { language } : {}),
    };

    const player = document.querySelector("#hyperplayer");
    if (file !== undefined) {
      player.src = URL.createObjectURL(file);
    } else {
      player.src = media;
      document.querySelector('#parakeet-hf-media').value = "";
    }

    // The transcription's media goes on the player BEFORE the busy signal.
    // hyperaudio-save captures what is being transcribed at that signal — the
    // player's media and the File behind it — so that a completion arriving
    // while the user has switched away is filed against the right project. A
    // URL set afterwards was too late: the capture took the OUTGOING project's
    // media, named the new project after it, and put its src back on the
    // player when the transcript landed.
    if (typeof setTranscriptBusy === 'function') {
      setTranscriptBusy(true);
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

// The transcript on the page from the endpoint's word list: the words and
// the language come from js/converters/parakeet.js (#751).
function parakeetHfParseData(json) {
  const converted = window.HyperaudioConverters.parakeet(json);
  const hyperTranscript = jsonToHTML({ words: converted.words, paragraphs: converted.paragraphs });

  const language = converted.language || "";
  // finishing while another project is open (#715): its track is not ours
  const background = typeof window.hyperaudioTranscriptionInBackground === 'function' && window.hyperaudioTranscriptionInBackground();
  const track = background ? null : document.querySelector('#hyperplayer-vtt');
  if (track) {
    track.label = language;
    track.srcLang = language;
  }

  const info = parakeetHfTranscriptionStart !== 0
    ? { ...parakeetHfTranscriptionMeta, seconds: (Date.now() - parakeetHfTranscriptionStart) / 1000 } : null;
  // finished while another project is open: it goes to Recents, and the screen stays where it is (#715)
  if (typeof window.hyperaudioKeepTranscription === 'function' && window.hyperaudioKeepTranscription({ html: hyperTranscript, info })) {
    return;
  }
  document.querySelector("#hypertranscript").innerHTML = hyperTranscript;
  document.querySelector('#download-html').setAttribute('href', 'data:text/html,' + encodeURIComponent(hyperTranscript));

  if (typeof setTranscriptionInfo === 'function' && info !== null) {
    setTranscriptionInfo(info);
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

// An error card is a message, not a document (#628), and the editor's notice
// helper is where a failed transcription is accounted for (#763, #764): the
// previous project's row is left unlit, and a failure that arrives while the
// user is viewing another project becomes a corner notice instead of a card
// painted over that project. Written straight into the transcript only when
// the helper is not there (the engine loaded on its own).
function showParakeetHfError(message) {
  const html = parakeetHfErrorHtml(message);
  if (typeof showTranscriptNotice === 'function') {
    showTranscriptNotice(html);
  } else {
    document.querySelector('#hypertranscript').innerHTML = html;
  }
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
    msg = "Sorry.<br/>The Hugging Face token appears to be invalid.";
  } else if (e.indexOf("402") >= 0) {
    // the router's own words are "Purchase pre-paid credits to continue using Inference Providers" (#777)
    msg = "Sorry.<br/>Your Hugging Face account has no credit for Inference Providers.<br/>Add pre-paid credits at huggingface.co/settings/billing.";
  } else if (e.indexOf("410") >= 0 || e.indexOf("404") >= 0) {
    // a provider can withdraw a model from Inference Providers without notice (#777)
    msg = "Sorry.<br/>Hugging Face no longer serves this model.<br/>The provider has withdrawn it.";
  } else if (e.indexOf("400") >= 0 || e.indexOf("422") >= 0) {
    msg = "Sorry.<br/>The request was rejected — the media may be unreadable or the model unavailable.";
  } else if (e.indexOf("503") >= 0 || e.indexOf("500") >= 0) {
    msg = "Sorry.<br/>Hugging Face inference is unavailable right now — try again shortly.";
  }
  showParakeetHfError(msg);
  console.error("Nemotron (HF) error:", error);
}

function displayParakeetHfNoWords() {
  if (typeof setTranscriptBusy === 'function') {
    setTranscriptBusy(false);
  }
  showParakeetHfError("Sorry.<br/>No words were detected.<br/>Please verify that the audio contains speech.");
}

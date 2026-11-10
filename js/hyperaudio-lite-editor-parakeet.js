/**
 * hyperaudio-lite-editor-parakeet.js
 * (C) The Hyperaudio Project
 * @version 1.3.46 — last changed in release 1.3.46
 * @license AGPL-3.0-only
 *
 * Hugging Face cloud transcription (#307, #777, #760) — speech models served
 * through Hugging Face's inference router by DeepInfra, called directly from
 * the browser with the user's own token (no server; the router endpoint is
 * CORS-open). The one key field also takes a DeepInfra API key (#760): a
 * Hugging Face token always begins "hf_", so any other key goes straight to
 * DeepInfra, which is who answers either way. The engine began as Parakeet TDT 0.6B v3 on the router's
 * Together route. Together withdrew that model from Inference Providers and
 * the router answered 410 for it (#777), and Together cannot be paid with the
 * account's pre-paid credits at all (the router's 402: "Pay-as-you go is not
 * enabled for provider together yet"), so the engine moved to DeepInfra,
 * which takes credits and serves several speech models on one route. The
 * dialog offers three, each answering a minute of audio in about three
 * seconds (verified live 2026-11-08):
 *
 *   NVIDIA Nemotron 3.5 Transcribe 30B — the most accurate on the test clip,
 *     $0.12 an hour of audio (2026-11), 40 languages. Echoes the requested
 *     language code back, "" when none was sent: it does not report what it
 *     heard. Speakers come only with a DeepInfra key: DeepInfra's diarize
 *     flag does not pass through the router's OpenAI-style route, so with
 *     "Label speakers" on the request goes to DeepInfra's own inference
 *     route for the model, which puts speaker_0, speaker_1… on every word
 *     (#760).
 *   Whisper large v3 turbo — $0.012 an hour, detects and reports the
 *     language as a code, word times within a tenth of a second of the 30B.
 *   Qwen3-ASR 1.7B — $0.027 an hour, 30 languages. Detects the language on
 *     its own whatever `language` says, and reports it as a NAME ("english"),
 *     which the language reader turns into a tag. Offered as auto-detect only.
 *
 * The small Nemotron 3.5 ASR 0.6B is not offered: its word starts run 0.22 s
 * late on an 80 ms grid and it misheard more. It is a streaming model, and
 * belongs to a live engine when the router has a streaming route.
 *
 * The element, the ids and this file keep their Parakeet names: the
 * remembered token and the lists that name the inputs are keyed on them.
 * Unlike AssemblyAI's async upload→poll, this is a single synchronous
 * multipart POST (like Deepgram):
 *
 *   POST router.huggingface.co/deepinfra/v1/openai/audio/transcriptions
 *     model=<DeepInfra's id>, file=<audio>,
 *     response_format=verbose_json, timestamp_granularities[]=word
 *
 * A model goes by DeepInfra's own id: the router does not map the Hub's id on
 * this route ("Model not supported by provider deepinfra", a 400). The route
 * takes ISO 639-1 codes in `language`.
 *
 * Response: { language, duration, text, words:[{word,start,end}] } with
 * start/end in SECONDS, the same for every model on the route. Parsed into
 * the same data-m/data-d spans the other engines emit. Reuses the global
 * helpers transcribingSvg / errorSvg and setTranscriptBusy / setTranscriptionInfo.
 *
 * With a DeepInfra key the same body goes to DeepInfra's OpenAI-compatible
 * route, api.deepinfra.com/v1/openai/audio/transcriptions, and the answer is
 * the same. With speakers asked for, Nemotron is called on DeepInfra's own
 * route instead:
 *
 *   POST api.deepinfra.com/v1/inference/<DeepInfra's id>
 *     audio=<audio>, chunk_level=word, diarize=true, language?
 *
 * which answers { text, language, input_length_ms, duration, segments,
 * words:[{word,start,end,speaker}] }. Its `duration` has been seen null, so
 * the billed length is read from input_length_ms when it is. Both DeepInfra
 * routes answer CORS preflight for a browser origin (checked 2026-11-10).
 */

const PARAKEET_HF_ENDPOINT = "https://router.huggingface.co/deepinfra/v1/openai/audio/transcriptions";
const DEEPINFRA_OPENAI_ENDPOINT = "https://api.deepinfra.com/v1/openai/audio/transcriptions";
const DEEPINFRA_INFERENCE_BASE = "https://api.deepinfra.com/v1/inference/";
// every Hugging Face access token begins hf_; anything else is DeepInfra's own
// key (those begin sk-di-, seen 2026-11-10, but the hf_ test is the one relied on)
const parakeetHfKeyIsHuggingFace = (key) => /^hf_/.test(String(key || "").trim());
// the model whose DeepInfra route labels speakers
const PARAKEET_HF_SPEAKER_MODEL = "nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B";

// One label per ISO 639-1 code the models between them offer
const PARAKEET_HF_LANGUAGE_LABELS = {
  af: "Afrikaans", ar: "Arabic", bn: "Bengali", bg: "Bulgarian", ca: "Catalan", zh: "Chinese (Mandarin)",
  hr: "Croatian", cs: "Czech", da: "Danish", nl: "Dutch", en: "English", et: "Estonian", fi: "Finnish",
  fr: "French", gl: "Galician", de: "German", el: "Greek", he: "Hebrew", hi: "Hindi", hu: "Hungarian",
  is: "Icelandic", id: "Indonesian", it: "Italian", ja: "Japanese", ko: "Korean", lv: "Latvian",
  lt: "Lithuanian", mk: "Macedonian", ms: "Malay", mt: "Maltese", mr: "Marathi", no: "Norwegian",
  fa: "Persian", pl: "Polish", pt: "Portuguese", ro: "Romanian", ru: "Russian", sr: "Serbian",
  sk: "Slovak", sl: "Slovenian", es: "Spanish", sw: "Swahili", sv: "Swedish", tl: "Tagalog",
  ta: "Tamil", te: "Telugu", th: "Thai", tr: "Turkish", uk: "Ukrainian", ur: "Urdu", vi: "Vietnamese",
  cy: "Welsh",
};

// The 40 languages Nemotron 3.5 Transcribe lists for transcription
const NEMOTRON_LANGUAGES = ["ar", "bn", "bg", "zh", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el",
  "he", "hi", "hu", "id", "it", "ja", "ko", "lv", "lt", "mt", "mr", "pl", "pt", "ro", "ru", "sk", "sl", "es",
  "sv", "tl", "ta", "te", "th", "tr", "uk", "vi"];
// Whisper knows 99. These are the ones with a label above.
const WHISPER_LANGUAGES = Object.keys(PARAKEET_HF_LANGUAGE_LABELS);

// The models, by DeepInfra's id. `languages` is what the Language select
// offers after "Auto-detect", in the order of the labels above.
// `usdPerMinute` is DeepInfra's published rate per minute of audio, which
// Hugging Face bills through without markup (read 2026-11-08). The info
// panel's estimated cost is the answer's `duration` times this (#780).
const PARAKEET_HF_MODELS = [
  { value: "nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B", label: "Nemotron 3.5 Transcribe 30B", languages: NEMOTRON_LANGUAGES, usdPerMinute: 0.002 },
  { value: "openai/whisper-large-v3-turbo", label: "Whisper large v3 turbo", languages: WHISPER_LANGUAGES, usdPerMinute: 0.0002 },
  { value: "Qwen/Qwen3-ASR-1.7B", label: "Qwen3-ASR 1.7B", languages: [], usdPerMinute: 0.00045 },
];
const PARAKEET_HF_MODEL = PARAKEET_HF_MODELS[0].value;

// The Language select for a model: "auto" omits the field and the model
// transcribes the language as spoken, then the codes the model lists.
function parakeetHfLanguagesFor(modelValue) {
  const model = PARAKEET_HF_MODELS.find((m) => m.value === modelValue) || PARAKEET_HF_MODELS[0];
  const codes = Object.keys(PARAKEET_HF_LANGUAGE_LABELS).filter((code) => model.languages.indexOf(code) !== -1);
  return [{ value: "auto", label: "Auto-detect" }].concat(codes.map((code) => ({ value: code, label: PARAKEET_HF_LANGUAGE_LABELS[code] })));
}

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
    const modelSel = document.querySelector('#parakeet-hf-model');
    const model = (modelSel && modelSel.value) || PARAKEET_HF_MODEL;
    const language = document.querySelector('#parakeet-hf-language').value;
    let media = document.querySelector('#parakeet-hf-media').value.trim();
    const file = document.querySelector('#parakeet-hf-file').files[0];

    if (apiKey === "" || (file === undefined && media === "")) {
      if (typeof setTranscriptBusy === 'function') {
        setTranscriptBusy(false);
      }
      showParakeetHfError("Please provide your Hugging Face token or DeepInfra API key, and either a media link or a file.");
      return;
    }

    if (file === undefined && !/^https?:\/\//i.test(media)) {
      media = "https://" + media;
    }

    // speakers: a DeepInfra key, the model whose DeepInfra route labels them,
    // and the toggle on (#760)
    const huggingFace = parakeetHfKeyIsHuggingFace(apiKey);
    const speakersToggle = document.querySelector('#parakeet-hf-speakers');
    const speakers = !huggingFace && model === PARAKEET_HF_SPEAKER_MODEL && speakersToggle !== null && speakersToggle.checked;

    parakeetHfTranscriptionStart = Date.now();
    const modelLabel = (PARAKEET_HF_MODELS.find((m) => m.value === model) || {}).label || model;
    parakeetHfTranscriptionMeta = {
      service: huggingFace ? "Hugging Face (cloud)" : "DeepInfra (cloud)",
      model: modelLabel,
      language: document.querySelector('#parakeet-hf-language').selectedOptions[0]?.textContent || language,
      languageCode: language,
      // what was really asked for (#668)
      modelId: model,
      parameters: Object.assign({ model },
        speakers ? { chunk_level: 'word', diarize: true } : { response_format: 'verbose_json', timestamp_granularities: ['word'] },
        language && language !== 'auto' ? { language } : {}),
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

    runParakeetHF(apiKey, file, media, { model, language, speakers }).catch(displayParakeetHfError);
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
    const modelSel = this.querySelector('#parakeet-hf-model');
    PARAKEET_HF_MODELS.forEach((m, i) => {
      const o = document.createElement('option');
      o.value = m.value;
      o.textContent = m.label;
      if (i === 0) o.selected = true;
      modelSel.appendChild(o);
    });
    this.populateLanguages(modelSel.value);
    // the Language list follows the model, keeping the choice when the new
    // model has it (the preferences restore the model first, then the language)
    modelSel.addEventListener('change', () => { this.populateLanguages(modelSel.value); this.showSpeakersToggle(); });
    this.querySelector('#parakeet-hf-key').addEventListener('input', () => this.showSpeakersToggle());
    this.showSpeakersToggle();
  }

  // "Label speakers" is offered only where it can be honoured: a DeepInfra
  // key and the Nemotron model (#760). The toggle keeps its state while
  // hidden, so a remembered choice comes back when the key is typed again.
  showSpeakersToggle() {
    const row = this.querySelector('#parakeet-hf-speakers-row');
    if (row === null) return;
    const key = this.querySelector('#parakeet-hf-key').value.trim();
    const model = this.querySelector('#parakeet-hf-model').value;
    const offered = key !== '' && !parakeetHfKeyIsHuggingFace(key) && model === PARAKEET_HF_SPEAKER_MODEL;
    row.style.display = offered ? 'flex' : 'none';
  }

  populateLanguages(modelValue) {
    const langSel = this.querySelector('#parakeet-hf-language');
    const previous = langSel.value;
    langSel.innerHTML = '';
    parakeetHfLanguagesFor(modelValue).forEach((l, i) => {
      const o = document.createElement('option');
      o.value = l.value;
      o.textContent = l.label;
      if (i === 0 || l.value === previous) o.selected = true;
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
  // a video goes up as its sound only (#788, js/cloud-audio.js)
  if (window.HyperaudioCloudAudio) {
    const upload = await window.HyperaudioCloudAudio.audioForUpload(blob, filename);
    blob = upload.blob;
    filename = upload.filename;
  }

  const model = opts.model || PARAKEET_HF_MODEL;
  const form = new FormData();
  let endpoint;
  if (opts.speakers === true) {
    // DeepInfra's own route for the model: the file is `audio`, the words
    // come with chunk_level=word, and diarize puts a speaker on each (#760)
    endpoint = DEEPINFRA_INFERENCE_BASE + model;
    form.append('audio', blob, filename);
    form.append('chunk_level', 'word');
    form.append('diarize', 'true');
  } else {
    endpoint = parakeetHfKeyIsHuggingFace(apiKey) ? PARAKEET_HF_ENDPOINT : DEEPINFRA_OPENAI_ENDPOINT;
    form.append('model', model);
    form.append('file', blob, filename);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
  }
  if (opts.language && opts.language !== 'auto') {
    form.append('language', opts.language);
  }

  const resp = await fetch(endpoint, {
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
// the language come from js/converters/parakeet.js (#751). The language is
// a code from Whisper and Nemotron and a name ("english") from Qwen, and the
// track wants a tag, so the editor's language reader settles it when loaded.
function parakeetHfParseData(json) {
  const converted = window.HyperaudioConverters.parakeet(json);
  const hyperTranscript = jsonToHTML({ words: converted.words, paragraphs: converted.paragraphs });

  const reader = window.HyperaudioSave && typeof window.HyperaudioSave.languageTag === 'function' ? window.HyperaudioSave.languageTag : null;
  const language = (reader ? reader(converted.language) : converted.language) || "";
  // finishing while another project is open (#715): its track is not ours
  const background = typeof window.hyperaudioTranscriptionInBackground === 'function' && window.hyperaudioTranscriptionInBackground();
  const track = background ? null : document.querySelector('#hyperplayer-vtt');
  if (track) {
    track.label = language;
    track.srcLang = language;
  }

  // the audio the service billed, as it reported it, and the model's rate.
  // DeepInfra's own route has answered with duration null and the length in
  // input_length_ms (#760), so that is read when duration is not there.
  const seconds = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const billed = seconds(json.duration) !== undefined ? seconds(json.duration)
    : seconds(json.input_length_ms) !== undefined ? Math.round(json.input_length_ms) / 1000 : undefined;
  const rate = (PARAKEET_HF_MODELS.find((m) => m.value === parakeetHfTranscriptionMeta.modelId) || {}).usdPerMinute;
  // stretches whose word times cannot be right (Nemotron on a long
  // recording, see squeezedRanges in js/converters/transcript-words.js):
  // named in the console now, in Project info, and kept with the project
  const unreliable = Array.isArray(converted.unreliableTiming) ? { unreliableTiming: converted.unreliableTiming } : {};
  if (unreliable.unreliableTiming) {
    console.warn('Transcript timing is unreliable: ' + unreliable.unreliableTiming.map((r) => `${r.start}–${r.end} s (${r.words} words)`).join(', ') + '. The words there are timed too close together to have been spoken.');
  }
  const info = parakeetHfTranscriptionStart !== 0
    ? { ...parakeetHfTranscriptionMeta, seconds: (Date.now() - parakeetHfTranscriptionStart) / 1000, audioSeconds: billed, rateUsdPerMinute: rate, ...unreliable } : null;
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
  // the card names whoever was asked: the router with a Hugging Face token,
  // DeepInfra itself with its key (#760)
  const deepInfra = parakeetHfTranscriptionMeta.service === "DeepInfra (cloud)";
  let msg = "Sorry.<br/>An unexpected error has occurred.";
  if (e.indexOf("media-fetch") >= 0) {
    msg = "Sorry.<br/>Couldn't fetch that media URL from the browser (it may block cross-origin requests). Try uploading the file instead.";
  } else if (e.indexOf("401") >= 0 || e.indexOf("403") >= 0) {
    msg = deepInfra ? "Sorry.<br/>The DeepInfra API key appears to be invalid." : "Sorry.<br/>The Hugging Face token appears to be invalid.";
  } else if (e.indexOf("402") >= 0) {
    // the router's own words are "Purchase pre-paid credits to continue using Inference Providers" (#777)
    msg = deepInfra
      ? "Sorry.<br/>Your DeepInfra account has no balance.<br/>Add a card or pre-pay at deepinfra.com/dash/billing."
      : "Sorry.<br/>Your Hugging Face account has no credit for Inference Providers.<br/>Add pre-paid credits at huggingface.co/settings/billing.";
  } else if (e.indexOf("410") >= 0 || e.indexOf("404") >= 0) {
    // a provider can withdraw a model from Inference Providers without notice (#777)
    msg = deepInfra ? "Sorry.<br/>DeepInfra no longer serves this model." : "Sorry.<br/>Hugging Face no longer serves this model.<br/>The provider has withdrawn it.";
  } else if (e.indexOf("400") >= 0 || e.indexOf("422") >= 0) {
    msg = "Sorry.<br/>The request was rejected — the media may be unreadable or the model unavailable.";
  } else if (e.indexOf("503") >= 0 || e.indexOf("500") >= 0) {
    msg = deepInfra ? "Sorry.<br/>DeepInfra is unavailable right now — try again shortly." : "Sorry.<br/>Hugging Face inference is unavailable right now — try again shortly.";
  }
  showParakeetHfError(msg);
  console.error(deepInfra ? "DeepInfra error:" : "Hugging Face error:", error);
}

function displayParakeetHfNoWords() {
  if (typeof setTranscriptBusy === 'function') {
    setTranscriptBusy(false);
  }
  showParakeetHfError("Sorry.<br/>No words were detected.<br/>Please verify that the audio contains speech.");
}

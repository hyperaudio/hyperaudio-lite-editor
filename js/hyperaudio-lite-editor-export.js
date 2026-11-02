/**
 * hyperaudio-lite-editor-export.js
 * (C) The Hyperaudio Project
 * @version 1.3.43 — last changed in release 1.3.43
 * @license MIT
 *
 * Export/import custom elements: transcript downloads and the Deepgram JSON,
 * SRT and WebVTT import dialogs.
 */

class ExportJson extends HTMLElement {

  constructor() {
    super();
  }

  exportJson() {
    downloadJson(htmlToJson(document.getElementById('hypertranscript')));
  }

  connectedCallback() {
    //this.innerHTML =  `<button onclick="${this.exportJson}">export json ⬇</button>`;
    this.innerHTML = `<a onclick="${this.exportJson}">Hyperaudio JSON</a>`;
    this.addEventListener('click', this.exportJson);
  }
}

customElements.define('export-json', ExportJson);

class ImportJson extends HTMLElement {

  constructor() {
    super();
  }

  importJson() {

    //import data from json file when click on import button
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json';
    fileInput.addEventListener('change', (event) => {
      const file = event.target.files[0];
      const reader = new FileReader();
      reader.addEventListener('load', (event) => {
        const jsonData = JSON.parse(event.target.result);
        // transform json object in html
        let hypertranscript = document.getElementById('hypertranscript');

        if (hypertranscript === null) {
          alert("Currently you can only import JSON from the Transcript View.");
        } else {
          if (typeof window.clearPendingTranscription === 'function') window.clearPendingTranscription();
          hypertranscript.innerHTML = jsonToHtml(jsonData);
          // The file's own media URL, or none: the player is cleared, so the
          // new project is born without the previous project's media (#757).
          const mediaUrl = jsonData.sections && jsonData.sections[0] && jsonData.sections[0].mediaUrl;
          const player = document.querySelector("#hyperplayer");
          if (mediaUrl) {
            player.src = mediaUrl;
          } else {
            player.removeAttribute('src');
            player.load();
          }
          // The birth, once the transcript and the player hold the import. It
          // was dispatched before the file had been read, so the new project
          // was born from the previous transcript and media.
          document.dispatchEvent(new CustomEvent('hyperaudioInit'));
        }
      });
      if (hypertranscript !== null) {
        reader.readAsText(file);
      }
    });
    fileInput.click();
  }

  connectedCallback() {
    //this.innerHTML =  `<button onclick="${this.importJson}">import json ⬆</button>`;
    this.innerHTML = `<a onclick="${this.importJson}">Hyperaudio JSON</a>`;
    this.addEventListener('click', this.importJson);
  }
}

customElements.define('import-json', ImportJson);

class ImportDeepgramJson extends HTMLElement {

  constructor() {
    super();
  }

  clearDeepgramJsonMediaUrl(event) {
    event.preventDefault();
    document.querySelector('#deepgram-json-media').value = "";
  }

  clearDeepgramJsonFilePicker(event) {
    event.preventDefault();
    document.querySelector('#deepgram-json-file').value = "";
  }

  confirmDeepgramJson() {
    let player = document.querySelector("#hyperplayer");
    const deepgramJsonMediaUrl = document.querySelector('#deepgram-json-media').value.trim();
    if (document.querySelector('#deepgram-json-file').value == ""){
      // no media at all: the player is cleared, as for SRT below (#757)
      if (deepgramJsonMediaUrl !== "") {
        player.src = deepgramJsonMediaUrl;
      } else {
        player.removeAttribute('src');
        player.load();
      }
    } else {
      const file = document.querySelector('[name=deepgram-json-file]').files[0];
      // Create a new FileReader instance
      const reader = new FileReader();
      reader.readAsArrayBuffer(file);
      let blob = null;

      reader.addEventListener('load', () => {

        file.arrayBuffer().then((arrayBuffer) => {
          blob = new Blob([new Uint8Array(arrayBuffer)], {type: file.type });
          player.src = URL.createObjectURL(blob);
        });
      });
    }

    const file = document.querySelector('[name=deepgram-json]').files[0];
    const reader = new FileReader();
    reader.addEventListener('load', (event) => {
      parseData(JSON.parse(event.target.result));
    });
    
    reader.readAsText(file);
  }

  connectedCallback() {
    this.innerHTML = `
    <div class="hidden-label-holder">
      <label for="file-import-deepgram-json-dialog">Import Deepgram JSON Dialog</label>
    </div>
    <input type="checkbox" id="file-import-deepgram-json-dialog" class="modal-toggle" tabindex="-1" aria-hidden="true" />
    <div class="modal">
    <div class="modal-box">
        <label for="file-import-deepgram-json-dialog" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">✕</label>
      <div class="flex flex-col gap-4 w-full">
        <h3 class="font-bold text-lg">Import Deepgram JSON Dialog</h3>
        <input id="deepgram-json-media" type="text" placeholder="Link to media" class="input input-bordered w-full max-w-xs" />
        <label class="label-text" for="deepgram-json-file">or use local media file</label>
        <input id="deepgram-json-file" name="deepgram-json-file" type="file" class="file-input w-full max-w-xs" title="" />
        <label class="label-text" for="deepgram-json">select local JSON file</label>
        <input id="deepgram-json" name="deepgram-json" type="file" class="file-input w-full max-w-xs" title="" />
      </div>
      <div class="modal-action">
        <label for="file-import-deepgram-json-dialog" class="btn btn-ghost">Cancel</label>
        <label id="file-import-deepgram-json" for="file-import-deepgram-json-dialog" class="btn btn-primary">Confirm</label>
      </div>
    </div>
    </div>`;

    document.querySelector('#deepgram-json-file').addEventListener('change',this.clearDeepgramJsonMediaUrl);
    document.querySelector('#deepgram-json-media').addEventListener('change',this.clearDeepgramJsonFilePicker);
    document.querySelector('#file-import-deepgram-json').addEventListener('click',this.confirmDeepgramJson);

    document.addEventListener('DOMContentLoaded', () => {
      const deepgramMediaInput = document.getElementById('deepgram-json-media');
      const deepgramFileInput = document.getElementById('deepgram-json-file');

      // Function to toggle the disabled state of inputs
      function toggleDeepgramInputDisabled() {
        if (deepgramMediaInput.value.trim() !== '') {
          deepgramFileInput.disabled = true;
        } else {
          deepgramFileInput.disabled = false;
        }

        if (deepgramFileInput.files.length > 0) {
          deepgramMediaInput.disabled = true;
        } else {
          deepgramMediaInput.disabled = false;
        }
      }

      // Add event listener to deepgram-media to monitor changes
      deepgramMediaInput.addEventListener('input', toggleDeepgramInputDisabled);

      // Add event listener to deepgram-file to monitor changes
      deepgramFileInput.addEventListener('change', toggleDeepgramInputDisabled);

      // Initial check to set the correct state on page load
      toggleDeepgramInputDisabled();
    });
  }
}

customElements.define('import-deepgram-json', ImportDeepgramJson);


class ImportSrt extends HTMLElement {

  constructor() {
    super();
  }

  clearSrtMediaUrl(event) {
    event.preventDefault();
    document.querySelector('#srt-media').value = "";
  }

  clearSrtFilePicker(event) {
    event.preventDefault();
    document.querySelector('#srt-file').value = "";
  }

  confirmSrt() {
    let player = document.querySelector("#hyperplayer");
    // The media goes on the player NOW, before the caption file is read and
    // the new project is created from it. It used to be read into memory
    // first (twice over), and a large video only reached the player after the
    // project had been created, so the project was saved with whatever media
    // the player held before: the previous project's. A File is a Blob, so it
    // can go on the player as it is; the save module captures the same File
    // from this input for the project's media.
    // No media at all: the player is CLEARED, so the new project is born with
    // none (#757). An empty string put on the player resolves to the page's
    // own address, and the birth saved the project as a link to index.html.
    const srtMediaUrl = document.querySelector('#srt-media').value.trim();
    if (document.querySelector('#srt-file').value != "") {
      player.src = URL.createObjectURL(document.querySelector('[name=srt-file]').files[0]);
    } else if (srtMediaUrl !== "") {
      player.src = srtMediaUrl;
    } else {
      player.removeAttribute('src');
      player.load();
    }

    const file = document.querySelector('[name=srt]').files[0];
    const reader = new FileReader();
    reader.addEventListener('load', (event) => {
      const srtData = event.target.result;

      let hypertranscript = document.getElementById('hypertranscript');
      hypertranscript.innerHTML = srtToHtml(srtData);

      const vttData = convertSrtToWebVtt(srtData);
      // Create a Blob object with the WebVTT data
      const blob = new Blob([vttData], { type: "text/vtt" });
      // Generate a URL for the Blob
      const vttUrl = URL.createObjectURL(blob);
      // Through the caption door (#356/#287): assigning .src on the reused track
      // leaves the previous document's cue pixels painted on the paused video.
      applyCaptionTrack(vttUrl, { mode: 'showing' });

      // an errored transcription's surviving identity must not claim this import
      if (typeof window.clearPendingTranscription === 'function') window.clearPendingTranscription();
      document.dispatchEvent(new CustomEvent('hyperaudioInit'));

      // Preserve original format — AFTER the init dispatch, which now
      // defaults caption sync ON for fresh transcripts; imported captions
      // are curated, so the override must land last.
      updateCaptionsFromTranscript = false;
      populateCaptionEditorFromVtt(vttData);
      //captionCache = vttData;
    });
    
    reader.readAsText(file);

  }


  connectedCallback() {
    this.innerHTML = `
    <div class="hidden-label-holder">
      <label for="file-import-srt-dialog">Import SRT Dialog</label>
    </div>
    <input type="checkbox" id="file-import-srt-dialog" class="modal-toggle" tabindex="-1" aria-hidden="true" />
    <div class="modal">
    <div class="modal-box">
        <label for="file-import-srt-dialog" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">✕</label>
      <div class="flex flex-col gap-4 w-full">
        <h3 class="font-bold text-lg">Import SRT Dialog</h3>
        <input id="srt-media" type="text" placeholder="Link to media" class="input input-bordered w-full max-w-xs" />
        <label class="label-text" for="srt-file">or use local media file</label>
        <input id="srt-file" name="srt-file" type="file" class="file-input w-full max-w-xs" title="" />
        <label class="label-text" for="srt">select local SRT file</label>
        <input id="srt" name="srt" type="file" class="file-input w-full max-w-xs" title="" />
      </div>
      <div class="modal-action">
        <label for="file-import-srt-dialog" class="btn btn-ghost">Cancel</label>
        <label id="file-import-srt" for="file-import-srt-dialog" class="btn btn-primary">Confirm</label>
      </div>
    </div>
    </div>`;

    document.querySelector('#srt').addEventListener('change',this.clearSrtMediaUrl);
    document.querySelector('#srt-media').addEventListener('change',this.clearSrtFilePicker);
    document.querySelector('#file-import-srt').addEventListener('click',this.confirmSrt);

    document.addEventListener('DOMContentLoaded', () => {
      const srtMediaInput = document.getElementById('srt-media');
      const srtFileInput = document.getElementById('srt-file');

      // Function to toggle the disabled state of inputs
      function toggleInputDisabled() {
        if (srtMediaInput.value.trim() !== '') {
          srtFileInput.disabled = true;
        } else {
          srtFileInput.disabled = false;
        }

        if (srtFileInput.files.length > 0) {
          srtMediaInput.disabled = true;
        } else {
          srtMediaInput.disabled = false;
        }
      }

      // Add event listener to srt-media to monitor changes
      srtMediaInput.addEventListener('input', toggleInputDisabled);

      // Add event listener to srt-file to monitor changes
      srtFileInput.addEventListener('change', toggleInputDisabled);

      // Initial check to set the correct state on page load
      toggleInputDisabled();
    });
  }
}

customElements.define('import-srt', ImportSrt);

class ImportVtt extends HTMLElement {

  constructor() {
    super();
  }

  clearVttMediaUrl(event) {
    event.preventDefault();
    document.querySelector('#vtt-media').value = "";
  }

  clearVttFilePicker(event) {
    event.preventDefault();
    document.querySelector('#vtt-file').value = "";
  }

  confirmVtt() {
    let player = document.querySelector("#hyperplayer");
    // The media goes on the player NOW, before the caption file is read and
    // the new project is created from it. It used to be read into memory
    // first (twice over), and a large video only reached the player after the
    // project had been created, so the project was saved with whatever media
    // the player held before: the previous project's. A File is a Blob, so it
    // can go on the player as it is; the save module captures the same File
    // from this input for the project's media.
    // No media at all: the player is cleared, as for SRT above (#757).
    const vttMediaUrl = document.querySelector('#vtt-media').value.trim();
    if (document.querySelector('#vtt-file').value != "") {
      player.src = URL.createObjectURL(document.querySelector('[name=vtt-file]').files[0]);
    } else if (vttMediaUrl !== "") {
      player.src = vttMediaUrl;
    } else {
      player.removeAttribute('src');
      player.load();
    }

    const file = document.querySelector('[name=vtt]').files[0];
    const reader = new FileReader();
    reader.addEventListener('load', (event) => {
      const vttData = event.target.result;

      let hypertranscript = document.getElementById('hypertranscript');
      hypertranscript.innerHTML = vttToHtml(vttData);

      const blob = new Blob([vttData], { type: "text/vtt" });
      // Generate a URL for the Blob
      const vttUrl = URL.createObjectURL(blob);
      // Through the caption door (#356/#287) — see the SRT import above.
      applyCaptionTrack(vttUrl, { mode: 'showing' });

      // an errored transcription's surviving identity must not claim this import
      if (typeof window.clearPendingTranscription === 'function') window.clearPendingTranscription();
      document.dispatchEvent(new CustomEvent('hyperaudioInit'));

      // Preserve original format — AFTER the init dispatch, which now
      // defaults caption sync ON for fresh transcripts; imported captions
      // are curated, so the override must land last.
      updateCaptionsFromTranscript = false;
      populateCaptionEditorFromVtt(vttData);
      //captionCache = vttData;
    });
    
    reader.readAsText(file);

  }


  connectedCallback() {
    this.innerHTML = `
    <div class="hidden-label-holder">
      <label for="file-import-vtt-dialog">Import VTT Dialog</label>
    </div>
    <input type="checkbox" id="file-import-vtt-dialog" class="modal-toggle" tabindex="-1" aria-hidden="true" />
    <div class="modal">
    <div class="modal-box">
        <label for="file-import-vtt-dialog" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">✕</label>
      <div class="flex flex-col gap-4 w-full">
        <h3 class="font-bold text-lg">Import VTT Dialog</h3>
        <input id="vtt-media" type="text" placeholder="Link to media" class="input input-bordered w-full max-w-xs" />
        <label class="label-text" for="vtt-file">or use local media file</label>
        <input id="vtt-file" name="vtt-file" type="file" class="file-input w-full max-w-xs" title="" />
        <label class="label-text" for="vtt">select local VTT file</label>
        <input id="vtt" name="vtt" type="file" class="file-input w-full max-w-xs" title="" />
      </div>
      <div class="modal-action">
        <label for="file-import-vtt-dialog" class="btn btn-ghost">Cancel</label>
        <label id="file-import-vtt" for="file-import-vtt-dialog" class="btn btn-primary">Confirm</label>
      </div>
    </div>
    </div>`;

    document.querySelector('#vtt').addEventListener('change',this.clearVttMediaUrl);
    document.querySelector('#vtt-media').addEventListener('change',this.clearVttFilePicker);
    document.querySelector('#file-import-vtt').addEventListener('click',this.confirmVtt);

    document.addEventListener('DOMContentLoaded', () => {
      const vttMediaInput = document.getElementById('vtt-media');
      const vttFileInput = document.getElementById('vtt-file');

      // Function to toggle the disabled state of inputs
      function toggleInputDisabled() {
        if (vttMediaInput.value.trim() !== '') {
          vttFileInput.disabled = true;
        } else {
          vttFileInput.disabled = false;
        }

        if (vttFileInput.files.length > 0) {
          vttMediaInput.disabled = true;
        } else {
          vttMediaInput.disabled = false;
        }
      }

      // Add event listener to srt-media to monitor changes
      vttMediaInput.addEventListener('input', toggleInputDisabled);

      // Add event listener to srt-file to monitor changes
      vttFileInput.addEventListener('change', toggleInputDisabled);

      // Initial check to set the correct state on page load
      toggleInputDisabled();
    });
  }
}

customElements.define('import-vtt', ImportVtt);

// Named from the project title like the other transcript downloads
// (editor-core.js), keeping the historical name for an untitled project (#683)
function jsonExportName() {
  const save = window.HyperaudioSave;
  const title = save && typeof save.getProjectTitle === 'function' ? save.getProjectTitle() : '';
  const base = typeof window.safeExportName === 'function' ? window.safeExportName(title, '') : '';
  return base === '' ? 'hyperaudio-lite.json' : base + '.json';
}

function downloadJson(jsonData) {
  // download json file
  let dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(jsonData, null, 2));
  //start download
  let downloadAnchorNode = document.createElement('a');
  downloadAnchorNode.setAttribute('href', dataStr);
  downloadAnchorNode.setAttribute('download', jsonExportName());
  document.body.appendChild(downloadAnchorNode); // required for firefox
  downloadAnchorNode.click();
  downloadAnchorNode.remove();
}

/**
* Converts SRT subtitle format to WebVTT format
* @param {string} srtContent - The SRT content as a string
* @returns {string} - The converted WebVTT content
*/
function convertSrtToWebVtt(srtContent) {
  // First, normalize line endings to ensure consistent processing across platforms
  const normalizedContent = srtContent.replace(/\r\n|\r/g, '\n');
  
  // WebVTT files must start with "WEBVTT" followed by a blank line
  let webVttContent = "WEBVTT\n\n";
  
  // Split the content into subtitle blocks (separated by blank lines)
  const subtitleBlocks = normalizedContent.split(/\n\s*\n/);
  
  for (const block of subtitleBlocks) {
    if (!block.trim()) continue;
    
    // Split each block into lines
    const lines = block.split('\n');
    
    // Skip the subtitle number (first line in SRT)
    // If the block doesn't have at least 2 lines, skip it
    if (lines.length < 2) continue;
    
    // Get the timestamp line (second line in SRT)
    const timestampLine = lines[1];
    
    // Convert SRT timestamp format (00:00:00,000) to WebVTT format (00:00:00.000)
    const webVttTimestamp = timestampLine.replace(/,/g, '.');
    
    // Add the timestamp line
    webVttContent += webVttTimestamp + '\n';
    
    // Add the subtitle text (all lines after the timestamp)
    const subtitleText = lines.slice(2).join('\n');
    webVttContent += subtitleText + '\n\n';
  }
  
  return webVttContent;
}

// Convert Hypertranscript to JSON.
//
// Emits three flat arrays:
//   words[]      — { start, end, text } in seconds, in document order.
//   paragraphs[] — { speaker, start, end } speaker turns spanning words.
//                  Paragraphs without an explicit speaker tag inherit the
//                  previous paragraph's speaker.
//   sections[]   — { start, end, mediaUrl } source-media context, one per
//                  <section> in the transcript HTML.
function htmlToJson(html) {
  const article = html.querySelector('article');
  if (!article) {
    return { words: [], paragraphs: [], sections: [] };
  }

  const player = document.querySelector('#hyperplayer');
  const mediaUrl = player ? player.src : '';

  const words = [];
  const paragraphs = [];
  const sections = [];
  let lastSpeaker = null;

  const sectionEls = article.querySelectorAll('section');
  for (const sectionEl of sectionEls) {
    const sectionStartIdx = words.length;

    const paragraphEls = sectionEl.querySelectorAll('p');
    for (const pEl of paragraphEls) {
      const paragraphStartIdx = words.length;
      let paragraphSpeaker = null;

      const spans = pEl.querySelectorAll('span[data-m]');
      for (const span of spans) {
        if (span.classList.contains('speaker')) {
          // Strip surrounding [brackets] from "[Angela]" → "Angela".
          const raw = span.textContent.trim();
          const match = raw.match(/^\[(.*)\]$/);
          paragraphSpeaker = match ? match[1].trim() : raw;
          continue;
        }
        const m = parseInt(span.getAttribute('data-m'), 10);
        const d = parseInt(span.getAttribute('data-d'), 10) || 0;
        const text = span.textContent.replace(/\s+$/, '');
        if (!isNaN(m) && text.length > 0) {
          words.push({
            start: m / 1000,
            end: (m + d) / 1000,
            text: text
          });
        }
      }

      if (words.length > paragraphStartIdx) {
        const effectiveSpeaker = paragraphSpeaker !== null ? paragraphSpeaker : lastSpeaker;
        if (paragraphSpeaker !== null) {
          lastSpeaker = paragraphSpeaker;
        }
        paragraphs.push({
          speaker: effectiveSpeaker,
          start: words[paragraphStartIdx].start,
          end: words[words.length - 1].end
        });
      }
    }

    if (words.length > sectionStartIdx) {
      sections.push({
        start: words[sectionStartIdx].start,
        end: words[words.length - 1].end,
        mediaUrl: mediaUrl
      });
    }
  }

  return { words, paragraphs, sections };
}


// Convert JSON to Hypertranscript HTML. Accepts the flat shape
// { words, paragraphs, sections } produced by htmlToJson.
function jsonToHtml(jsonData) {
  // Paragraph-less input used to produce <article><section></section></article>
  // — every word silently gone, because the emit loop below is driven entirely
  // by paragraphs and there were none. That was reachable from the JSON import
  // path above and from native-app callers of window.jsonToHtml, so this needs
  // its own guarantee (#492) rather than relying on a normalised caller: the
  // shared normaliser when it is loaded, an inline span otherwise.
  const normalized = typeof window !== 'undefined' && typeof window.normalizeTranscriptParagraphs === 'function'
    ? window.normalizeTranscriptParagraphs(jsonData)
    : jsonData;
  const words = (normalized && normalized.words) || [];
  const fromNormaliser = (normalized && normalized.paragraphs) || [];
  const paragraphs = fromNormaliser.length > 0 || words.length === 0
    ? fromNormaliser
    : [{ start: words[0].start, end: words[words.length - 1].end, speaker: null }];
  const sections = (jsonData && jsonData.sections && jsonData.sections.length > 0)
    ? jsonData.sections
    : [{ start: -Infinity, end: Infinity }];

  // Bucket paragraphs into their section. Both arrays are sorted by start,
  // so a two-pointer walk handles boundary equality (paragraph start equal
  // to a section end) correctly.
  const paragraphsBySection = sections.map(() => []);
  let si = 0;
  for (const para of paragraphs) {
    while (si < sections.length - 1 && para.start > sections[si].end) si++;
    paragraphsBySection[si].push(para);
  }

  // Same idea for words → paragraphs.
  const wordsByParagraph = new Map();
  for (const para of paragraphs) wordsByParagraph.set(para, []);
  let pi = 0;
  for (const w of words) {
    while (pi < paragraphs.length - 1 && w.start > paragraphs[pi].end) pi++;
    if (paragraphs[pi]) wordsByParagraph.get(paragraphs[pi]).push(w);
  }

  const article = document.createElement('article');
  let lastSpeakerEmitted = null;

  for (let s = 0; s < sections.length; s++) {
    const sectionEl = document.createElement('section');
    article.appendChild(sectionEl);

    for (const para of paragraphsBySection[s]) {
      const pEl = document.createElement('p');
      sectionEl.appendChild(pEl);

      if (para.speaker && para.speaker !== lastSpeakerEmitted) {
        const speakerSpan = document.createElement('span');
        speakerSpan.className = 'speaker';
        speakerSpan.setAttribute('data-m', String(Math.round(para.start * 1000)));
        speakerSpan.setAttribute('data-d', '0');
        speakerSpan.textContent = `[${para.speaker}] `;
        pEl.appendChild(speakerSpan);
        lastSpeakerEmitted = para.speaker;
      }

      for (const w of wordsByParagraph.get(para) || []) {
        const span = document.createElement('span');
        span.setAttribute('data-m', String(Math.round(w.start * 1000)));
        span.setAttribute('data-d', String(Math.round((w.end - w.start) * 1000)));
        span.textContent = w.text + ' ';
        pEl.appendChild(span);
      }
    }
  }

  const div = document.createElement('div');
  div.appendChild(article);
  return div.innerHTML;
}

// Expose globally for native app integration
window.jsonToHtml = jsonToHtml;
window.srtToHtml = srtToHtml;
window.vttToHtml = vttToHtml;
window.convertSrtToWebVtt = convertSrtToWebVtt;

// A caption file as transcript markup: js/converters/captions.js (#751).
// These stay as globals: a native host calls srtToHtml and vttToHtml.
function captionWordsToHtml(captionWords) {
  return window.HyperaudioConverters.captionWordsToHtml(captionWords);
}

function srtToHtml(data) {
  return window.HyperaudioConverters.srt(data);
}

/**
 * Converts WebVTT subtitle format to HTML for the hypertranscript
 * @param {string} data - The WebVTT content as a string
 * @returns {string} - The converted HTML content
 */
function vttToHtml(data) {
  return window.HyperaudioConverters.vtt(data);
}

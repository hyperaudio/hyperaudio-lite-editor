class ExportJson extends HTMLElement {

  constructor() {
    super();
  }

  exportJson() {
    let hypertranscript = document.getElementById('hypertranscript');

    if (hypertranscript === null) {
      alert("Currently you can only export JSON from the transcript view.");
    } else {
      let jsonData = htmlToJson(hypertranscript);
      downloadJson(jsonData);
    }
  }

  connectedCallback() {
    //this.innerHTML =  `<button onclick="${this.exportJson}">export json ⬇</button>`;
    this.innerHTML = `<a onclick="${this.exportJson}">Export Hyperaudio JSON</a>`;
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
          hypertranscript.innerHTML = jsonToHtml(jsonData);
          const mediaUrl = jsonData.sections && jsonData.sections[0] && jsonData.sections[0].mediaUrl;
          if (mediaUrl) {
            document.querySelector("#hyperplayer").src = mediaUrl;
          }
        }
      });
      if (hypertranscript !== null) {
        reader.readAsText(file);
        document.dispatchEvent(new CustomEvent('hyperaudioInit'));
      }
    });
    fileInput.click();
  }

  connectedCallback() {
    //this.innerHTML =  `<button onclick="${this.importJson}">import json ⬆</button>`;
    this.innerHTML = `<a onclick="${this.importJson}">Import Hyperaudio JSON</a>`;
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
    if (document.querySelector('#deepgram-json-file').value == ""){
      player.src = document.querySelector('#deepgram-json-media').value;
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
      <div class="flex flex-col gap-4 w-full">
        <label for="file-import-deepgram-json-dialog" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">✕</label>
        <h3 class="font-bold text-lg">Import Deepgram JSON Dialog</h3>
        <input id="deepgram-json-media" type="text" placeholder="Link to media" class="input input-bordered w-full max-w-xs" />
        <label class="label-text" for="deepgram-json-file">or use local media file</label>
        <input id="deepgram-json-file" name="deepgram-json-file" type="file" class="file-input w-full max-w-xs" />
        <label class="label-text" for="deepgram-json">select local JSON file</label>
        <input id="deepgram-json" name="deepgram-json" type="file" class="file-input w-full max-w-xs" />
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
    if (document.querySelector('#srt-file').value == ""){
      console.log("new src ", document.querySelector('#srt-media').value);
      player.src = document.querySelector('#srt-media').value;
    } else {
      const file = document.querySelector('[name=srt-file]').files[0];
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
      document.querySelector('#hyperplayer-vtt').src = vttUrl;

      // Preserve original format
      updateCaptionsFromTranscript = false;
      populateCaptionEditorFromVtt(vttData);
      //captionCache = vttData;

      document.dispatchEvent(new CustomEvent('hyperaudioInit'));
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
      <div class="flex flex-col gap-4 w-full">
        <label for="file-import-srt-dialog" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">✕</label>
        <h3 class="font-bold text-lg">Import SRT Dialog</h3>
        <input id="srt-media" type="text" placeholder="Link to media" class="input input-bordered w-full max-w-xs" />
        <label class="label-text" for="srt-file">or use local media file</label>
        <input id="srt-file" name="srt-file" type="file" class="file-input w-full max-w-xs" />
        <label class="label-text" for="srt">select local SRT file</label>
        <input id="srt" name="srt" type="file" class="file-input w-full max-w-xs" />
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
    if (document.querySelector('#vtt-file').value == ""){
      console.log("new src ", document.querySelector('#vtt-media').value);
      player.src = document.querySelector('#vtt-media').value;
    } else {
      const file = document.querySelector('[name=vtt-file]').files[0];
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

    const file = document.querySelector('[name=vtt]').files[0];
    const reader = new FileReader();
    reader.addEventListener('load', (event) => {
      const vttData = event.target.result;

      let hypertranscript = document.getElementById('hypertranscript');
      hypertranscript.innerHTML = vttToHtml(vttData);

      const blob = new Blob([vttData], { type: "text/vtt" });
      // Generate a URL for the Blob
      const vttUrl = URL.createObjectURL(blob);
      document.querySelector('#hyperplayer-vtt').src = vttUrl;

      // Preserve original format
      updateCaptionsFromTranscript = false;
      populateCaptionEditorFromVtt(vttData);
      //captionCache = vttData;

      document.dispatchEvent(new CustomEvent('hyperaudioInit'));
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
      <div class="flex flex-col gap-4 w-full">
        <label for="file-import-vtt-dialog" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">✕</label>
        <h3 class="font-bold text-lg">Import VTT Dialog</h3>
        <input id="vtt-media" type="text" placeholder="Link to media" class="input input-bordered w-full max-w-xs" />
        <label class="label-text" for="vtt-file">or use local media file</label>
        <input id="vtt-file" name="vtt-file" type="file" class="file-input w-full max-w-xs" />
        <label class="label-text" for="vtt">select local VTT file</label>
        <input id="vtt" name="vtt" type="file" class="file-input w-full max-w-xs" />
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

function downloadJson(jsonData) {
  // download json file
  let dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(jsonData, null, 2));
  //start download
  let downloadAnchorNode = document.createElement('a');
  downloadAnchorNode.setAttribute('href', dataStr);
  downloadAnchorNode.setAttribute('download', 'hyperaudio-lite.json');
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
  const words = (jsonData && jsonData.words) || [];
  const paragraphs = (jsonData && jsonData.paragraphs) || [];
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

function srtToHtml(data) {
  let i = 0,
  len = 0,
  idx = 0,
  lines,
  time,
  text,
  sub;

  // Simple function to convert HH:MM:SS,MMM or HH:MM:SS.MMM to SS.MMM
  // Assume valid, returns 0 on error

  let toSeconds = function(t_in) {
    let t = t_in.split(':');

    try {
      let s = t[2].split(',');

      // Just in case a . is decimal seperator
      if (s.length === 1) {
        s = t[2].split('.');
      }

      return (
        parseFloat(t[0], 10) * 3600 +
        parseFloat(t[1], 10) * 60 +
        parseFloat(s[0], 10) +
        parseFloat(s[1], 10) / 1000
      );
    } catch (e) {
      return 0;
    }
  };

  let paraSplitTime = 1.5;
  let paraPunct = true;
  let outputString = '<article><section><p>';
  let lineBreaks = false;
  let ltime = 0;
  let ltext;

  // Here is where the magic happens
  // Split on line breaks
  lines = data.split(/(?:\r\n|\r|\n)/gm);
  len = lines.length;

  for (i = 0; i < len; i++) {
    sub = {};
    text = [];

    sub.id = parseInt(lines[i++], 10);

    // Split on '-->' delimiter, trimming spaces as well

    try {
      time = lines[i++].split(/[\t ]*-->[\t ]*/);
    } catch (e) {
      console.log('Warning. Possible issue on line ' + i + ": '" + lines[i] + "'.");
      break;
    }

    sub.start = toSeconds(time[0]);

    // So as to trim positioning information from end
    if (!time[1]) {
      alert('Warning. Issue on line ' + i + ": '" + lines[i] + "'.");
      return;
    }

    idx = time[1].indexOf(' ');
    if (idx !== -1) {
      time[1] = time[1].substr(0, idx);
    }
    sub.end = toSeconds(time[1]);

    // Build single line of text from multi-line subtitle in file
    while (i < len && lines[i]) {
      text.push(lines[i++]);
    }

    // Join into 1 line, SSA-style linebreaks
    // Strip out other SSA-style tags
    sub.text = text.join('\\N').replace(/\{(\[\w]+\(?([\w\d]+,?)+\)?)+\}/gi, '');

    // Escape HTML entities
    sub.text = sub.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Unescape great than and less than when it makes a valid html tag of a supported style (font, b, u, s, i)
    // Modified version of regex from Phil Haack's blog: http://haacked.com/archive/2004/10/25/usingregularexpressionstomatchhtml.aspx
    // Later modified by kev: http://kevin.deldycke.com/2007/03/ultimate-regular-expression-for-html-tag-parsing-with-php/
    sub.text = sub.text.replace(
      /&lt;(\/?(font|b|u|i|s))((\s+(\w|\w[\w\-]*\w)(\s*=\s*(?:\".*?\"|'.*?'|[^'\">\s]+))?)+\s*|\s*)(\/?)&gt;/gi,
      '<$1$3$7>'
    );
    //sub.text = sub.text.replace( /\\N/gi, "<br />" );
    sub.text = sub.text.replace(/\\N/gi, ' ');

    let splitMode = 0;

    let wordLengthSplit = true; //$('#word-length').prop('checked');

    // enhancements to take account of word length

    let swords = sub.text.split(' ');
    let sduration = sub.end - sub.start;
    let stimeStep = sduration / swords.length;

    // determine length of words

    let swordLengths = [];

    let totalLetters = 0;
    for (let si = 0, sl = swords.length; si < sl; ++si) {
      totalLetters = totalLetters + swords[si].length;
      swordLengths[si] = swords[si].length;
    }

    let letterTime = sduration / totalLetters;
    let wordStart = 0;

    for (let si = 0, sl = swords.length; si < sl; ++si) {
      let wordTime = swordLengths[si] * letterTime;
      let stime;
      if (wordLengthSplit) {
        stime = Math.round((sub.start + si * stimeStep) * 1000);
      } else {
        stime = Math.round((wordStart + sub.start) * 1000);
      }

      wordStart = wordStart + wordTime;
      let stext = swords[si];

      if (stime - ltime > paraSplitTime * 1000 && paraSplitTime > 0) {

        let punctPresent =
          ltext && (ltext.indexOf('.') > 0 || ltext.indexOf('?') > 0 || ltext.indexOf('!') > 0);
        if (!paraPunct || (paraPunct && punctPresent)) {
          outputString += '</p><p>';
        }
      }

      outputString += '<span data-m="' + stime + '">' + stext + ' </span>';

      ltime = stime;
      ltext = stext;

      if (lineBreaks) outputString = outputString + '\n';
    }
  }
  return outputString + '</p></section></article>';
}

/**
 * Converts WebVTT subtitle format to HTML for the hypertranscript
 * @param {string} data - The WebVTT content as a string
 * @returns {string} - The converted HTML content
 */
function vttToHtml(data) {
  let i = 0,
  len = 0,
  lines,
  time,
  text,
  sub;

  // Simple function to convert HH:MM:SS.MMM to seconds
  // Assume valid, returns 0 on error
  let toSeconds = function(t_in) {
    let t = t_in.split(':');

    try {
      let s = t[2].split('.');

      // Just in case a , is decimal separator
      if (s.length === 1) {
        s = t[2].split(',');
      }

      return (
        parseFloat(t[0], 10) * 3600 +
        parseFloat(t[1], 10) * 60 +
        parseFloat(s[0], 10) +
        parseFloat(s[1], 10) / 1000
      );
    } catch (e) {
      return 0;
    }
  };

  let paraSplitTime = 1.5;
  let paraPunct = true;
  let outputString = '<article><section><p>';
  let lineBreaks = false;
  let ltime = 0;
  let ltext;

  // Split on line breaks
  lines = data.split(/(?:\r\n|\r|\n)/gm);
  len = lines.length;

  // Skip the WEBVTT header line
  let startLine = 0;
  if (lines[0].indexOf('WEBVTT') === 0) {
    startLine = 1;
    
    // Skip any header metadata lines
    while (startLine < len && lines[startLine].trim() !== '') {
      startLine++;
    }
    
    // Skip the blank line after the header
    startLine++;
  }

  for (i = startLine; i < len; i++) {
    sub = {};
    text = [];

    // Skip empty lines
    if (!lines[i].trim()) {
      continue;
    }

    // Check if the line is a cue identifier (optional in WebVTT)
    if (lines[i].indexOf('-->') === -1) {
      // This might be a cue identifier, skip to the next line
      i++;
      
      // Skip if we've reached the end
      if (i >= len) break;
    }

    // Parse the timestamp line
    if (lines[i].indexOf('-->') !== -1) {
      time = lines[i].split(/[\t ]*-->[\t ]*/);
      
      sub.start = toSeconds(time[0]);

      // Extract end time, removing any cue settings
      let endTimeStr = time[1].split(/[\t ]/)[0];
      sub.end = toSeconds(endTimeStr);

      // Move to the next line, which should be the start of the text
      i++;

      // Collect all lines of text until we hit an empty line
      while (i < len && lines[i].trim() !== '') {
        text.push(lines[i]);
        i++;
      }

      // Join the text lines
      sub.text = text.join(' ').replace(/\{(\[\w]+\(?([\w\d]+,?)+\)?)+\}/gi, '');

      // Escape HTML entities
      sub.text = sub.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

      // Unescape specific HTML tags
      sub.text = sub.text.replace(
        /&lt;(\/?(font|b|u|i|s))((\s+(\w|\w[\w\-]*\w)(\s*=\s*(?:\".*?\"|'.*?'|[^'\">\s]+))?)+\s*|\s*)(\/?)&gt;/gi,
        '<$1$3$7>'
      );

      // Split into words for timestamping
      let swords = sub.text.split(' ');
      let sduration = sub.end - sub.start;
      let stimeStep = sduration / swords.length;

      // Determine length of words
      let swordLengths = [];
      let totalLetters = 0;
      
      for (let si = 0, sl = swords.length; si < sl; ++si) {
        totalLetters = totalLetters + swords[si].length;
        swordLengths[si] = swords[si].length;
      }

      let letterTime = sduration / totalLetters;
      let wordStart = 0;
      let wordLengthSplit = true;

      for (let si = 0, sl = swords.length; si < sl; ++si) {
        let wordTime = swordLengths[si] * letterTime;
        let stime;
        
        if (wordLengthSplit) {
          stime = Math.round((sub.start + si * stimeStep) * 1000);
        } else {
          stime = Math.round((wordStart + sub.start) * 1000);
        }

        wordStart = wordStart + wordTime;
        let stext = swords[si];

        if (stime - ltime > paraSplitTime * 1000 && paraSplitTime > 0) {
          let punctPresent =
            ltext && (ltext.indexOf('.') > 0 || ltext.indexOf('?') > 0 || ltext.indexOf('!') > 0);
          
          if (!paraPunct || (paraPunct && punctPresent)) {
            outputString += '</p><p>';
          }
        }

        outputString += '<span data-m="' + stime + '">' + stext + ' </span>';

        ltime = stime;
        ltext = stext;

        if (lineBreaks) outputString = outputString + '\n';
      }
    }
  }
  
  return outputString + '</p></section></article>';
}

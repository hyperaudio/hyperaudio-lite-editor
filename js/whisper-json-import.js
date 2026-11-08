/*! (C) The Hyperaudio Project. AGPL 3.0 @license: https://www.gnu.org/licenses/agpl-3.0.en.html */
/*! Hyperaudio Lite Editor - Whisper JSON import. @version 1.3.45 — last changed in release 1.3.45 */

// Self-contained, modular import feature (#631). To remove it entirely:
// delete this file, its <script> tag in index.html, the
// <import-whisper-json> menu item and element mount, and the converter
// js/converters/whisper-json.js.
//
// This is the dialog: the file is chosen here, read, and handed to the
// converter (js/converters/whisper-json.js, #751), which reads the five
// Whisper JSON dialects into the editor's canonical { words, paragraphs }.
// What comes back goes through jsonToHTML onto the page, so nothing here
// builds transcript markup by hand.

(function () {
  'use strict';

  const converters = () => (typeof window !== 'undefined' ? window.HyperaudioConverters : null)
    || (typeof require === 'function' ? require('./converters/whisper-json.js') : null);

  // the converter's door, under the name this module has always exported
  const whisperJsonToTranscript = (json) => converters().whisperJson(json);
  const detectDialect = (json) => converters().detectDialect(json);

  /* ---- The menu item and its dialog ------------------------------------- */

  const byId = (id) => document.getElementById(id);

  function ensureDialog() {
    if (byId('file-import-whisper-json-dialog') !== null) return;
    const holder = document.createElement('div');
    holder.innerHTML =
      '<input type="checkbox" id="file-import-whisper-json-dialog" class="modal-toggle" tabindex="-1" aria-hidden="true" />'
      + '<div class="modal"><div class="modal-box relative">'
      + '<label for="file-import-whisper-json-dialog" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">✕</label>'
      + '<h3 class="font-bold text-lg">Import Whisper JSON</h3>'
      + '<p style="margin-top:8px; font-size:0.9rem; opacity:0.75">From the Whisper command line, the OpenAI API, whisper.cpp, WhisperX or a Hugging Face pipeline. Word timings are used where the file has them; otherwise each segment’s words are spread across it.</p>'
      + '<div class="flex flex-col gap-4 w-full" style="margin-top:16px">'
      + '<input id="whisper-json-media" type="text" placeholder="Link to media" class="input input-bordered w-full max-w-xs" />'
      + '<label class="label-text" for="whisper-json-file">or use local media file</label>'
      + '<input id="whisper-json-file" name="whisper-json-file" type="file" class="file-input w-full max-w-xs" title="" />'
      + '<label class="label-text" for="whisper-json">select local JSON file</label>'
      + '<input id="whisper-json" name="whisper-json" type="file" accept="application/json,.json" class="file-input w-full max-w-xs" title="" />'
      + '<p id="whisper-json-status" role="status" aria-live="polite" style="min-height:1.4em; font-size:0.9rem; margin:0"></p>'
      + '</div>'
      + '<div class="modal-action">'
      + '<label for="file-import-whisper-json-dialog" class="btn btn-ghost">Cancel</label>'
      + '<button type="button" id="file-import-whisper-json" class="btn btn-primary">Import</button>'
      + '</div>'
      + '</div></div>';
    document.body.appendChild(holder);

    const mediaUrl = byId('whisper-json-media');
    const mediaFile = byId('whisper-json-file');
    const jsonFile = byId('whisper-json');
    const status = byId('whisper-json-status');

    // one media source or the other, as the other import dialogs do
    mediaUrl.addEventListener('input', () => { mediaFile.disabled = mediaUrl.value.trim() !== ''; });
    mediaFile.addEventListener('change', () => { mediaUrl.disabled = mediaFile.files.length > 0; });

    byId('file-import-whisper-json').addEventListener('click', async () => {
      status.style.color = '';
      const file = jsonFile.files && jsonFile.files[0];
      if (!file) { status.textContent = 'Choose a Whisper JSON file first.'; return; }
      const transcript = byId('hypertranscript');
      if (transcript === null || typeof jsonToHTML !== 'function') {
        status.textContent = 'You can only import into the transcript view.';
        return;
      }
      let result;
      try {
        result = whisperJsonToTranscript(JSON.parse(await file.text()));
      } catch (e) {
        status.style.color = 'oklch(var(--er))';
        status.textContent = e instanceof SyntaxError ? 'That file is not valid JSON.' : e.message;
        return;
      }

      const player = document.querySelector('#hyperplayer');
      if (player !== null) {
        // a host that keeps the media itself may name its own URL for the
        // file, and the project is then a link to it rather than a copy (#781)
        if (mediaFile.files && mediaFile.files[0]) {
          const file = mediaFile.files[0];
          const host = window.HyperaudioSave && typeof window.HyperaudioSave.hostMediaUrl === 'function' ? window.HyperaudioSave.hostMediaUrl(file) : null;
          player.src = host || URL.createObjectURL(file);
        }
        else if (mediaUrl.value.trim() !== '') player.src = mediaUrl.value.trim();
        else {
          // no media at all: the player is cleared, so the new project is born
          // with none rather than the previous project's media (#757)
          player.removeAttribute('src');
          player.load();
        }
      }

      const track = document.querySelector('#hyperplayer-vtt');
      if (track !== null && result.language) {
        // setAttribute, not the IDL property: the attribute is `srclang`, all
        // lower case, so `track.srcLang = …` sets an expando and nothing else
        track.setAttribute('label', result.language);
        track.setAttribute('srclang', result.language);
      }

      // the same door the other imports use
      if (typeof window.clearPendingTranscription === 'function') window.clearPendingTranscription();
      transcript.innerHTML = jsonToHTML({ words: result.words, paragraphs: result.paragraphs });
      document.dispatchEvent(new CustomEvent('hyperaudioInit'));
      status.textContent = '';
      byId('file-import-whisper-json-dialog').checked = false;
    });
  }

  // The element is declared only in a browser: `extends HTMLElement` is
  // evaluated at load, and the converter's door above is kept for the unit
  // tests in node, where there is no such class.
  if (typeof customElements !== 'undefined' && typeof HTMLElement !== 'undefined') {
    customElements.define('import-whisper-json', class extends HTMLElement {
      connectedCallback() {
        ensureDialog();
        this.innerHTML = '<label for="file-import-whisper-json-dialog">Whisper JSON</label>';
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.WhisperJsonImport = Object.freeze({ whisperJsonToTranscript, detectDialect });
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { whisperJsonToTranscript, detectDialect };
  }
})();

/**
 * demo.js — the embeddable "try it" demo (#691, as a branch rather than a
 * ?demo=1 flag). Loaded before everything else in index.html, it makes this
 * copy of the editor a clean, self-contained demo:
 *
 *  - No service worker: none is registered (index.html no longer loads
 *    editor-service-worker.js), and the editor's own worker, if a visit to
 *    another copy in this folder once installed one, is removed. A worker
 *    registered by another app at a wider scope is that app's, and is left.
 *  - Nothing persists, and nothing is shared: the project library's storage
 *    (OPFS) is hidden, so the editor runs as it does in a browser without
 *    it, and localStorage is held in memory for this page only. Every load
 *    starts from the intro, and another copy of the editor on the same
 *    origin is neither read nor written.
 *  - A trimmed interface: no transcription, import, saving, project or data
 *    exports, or media export. The File menu keeps its lightweight downloads —
 *    captions, the HTML and interactive transcripts, and TXT/Markdown/Word.
 *  - Files dropped on the page are ignored.
 *
 * Kept to this one file (and two lines of index.html) so the branch stays
 * easy to bring up to date with main.
 */
(function () {
  // --- localStorage, in memory ---------------------------------------------
  // The editor only calls getItem/setItem/removeItem. Patching Storage's
  // prototype for the local store alone works in every browser, where
  // replacing window.localStorage does not.
  try {
    const real = window.localStorage;
    const memory = new Map();
    const proto = Storage.prototype;
    const getItem = proto.getItem;
    const setItem = proto.setItem;
    const removeItem = proto.removeItem;
    const clear = proto.clear;
    proto.getItem = function (key) {
      return this === real ? (memory.has(String(key)) ? memory.get(String(key)) : null) : getItem.call(this, key);
    };
    proto.setItem = function (key, value) {
      if (this === real) memory.set(String(key), String(value)); else setItem.call(this, key, value);
    };
    proto.removeItem = function (key) {
      if (this === real) memory.delete(String(key)); else removeItem.call(this, key);
    };
    proto.clear = function () {
      if (this === real) memory.clear(); else clear.call(this);
    };
  } catch (e) { /* no localStorage at all: nothing to keep apart */ }

  // --- the project library's storage, hidden --------------------------------
  try {
    if (typeof StorageManager !== 'undefined' && StorageManager.prototype.getDirectory) {
      delete StorageManager.prototype.getDirectory;
    }
  } catch (e) { /* not removable: the editor would find it, as it would anyway */ }

  // --- no service worker ----------------------------------------------------
  if ('serviceWorker' in navigator) {
    const folder = new URL('./', window.location.href).href;
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.filter((r) => r.scope.startsWith(folder)).forEach((r) => r.unregister());
    }).catch(() => {});
  }

  // --- saving: there is no library to save to, and the fallback, a
  // .hyperaudio download, is a project export the demo leaves out; the
  // shortcut does nothing rather than the browser saving the page ---------
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  // --- files dropped on the page: ignored -----------------------------------
  ['dragover', 'drop'].forEach((type) => {
    window.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, true);
  });

  // --- the trimmed interface ------------------------------------------------
  const style = document.createElement('style');
  style.textContent = [
    // transcription
    '#new-transcription-btn, #upload-transcribe-btn, #upload-align-btn',
    // import, and the File menu's divider under the transcription items
    '#file-dropdown > li:has(#file-import-submenu), #file-dropdown > hr',
    // project and data exports; the document exports (TXT/MD/Word) stay
    '#file-export-submenu li:has(> export-json), #file-export-submenu li:has(> export-ionosphere)',
    '#file-export-submenu li:has(> publish-ionosphere), #file-export-submenu li:has(#project-export-hyperaudio)',
    // media export
    '#export-media-btn, #file-download-submenu li:has(> label[for="export-modal"])',
    // Recents and Save: nothing is kept, so nothing to list or save
    '#recents-card, #project-save-btn',
  ].join(',\n') + ' { display: none !important; }';
  document.head.appendChild(style);
})();

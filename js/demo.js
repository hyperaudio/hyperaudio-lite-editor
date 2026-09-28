/**
 * demo.js — the embeddable "try it" demo (#691, as a branch rather than a
 * ?demo=1 flag). Loaded before everything else in index.html, it makes this
 * copy of the editor a clean, self-contained demo:
 *
 *  - No service worker: none is registered (index.html no longer loads
 *    editor-service-worker.js), and the editor's own worker, if a visit to
 *    another copy in this folder once installed one, is removed. A worker
 *    registered by another app at a wider scope is that app's, and is left.
 *  - A library of its own, fresh on every load. Browser storage (OPFS) is
 *    shared by the whole origin, so the editor is handed a private folder
 *    inside it instead of the root: its projects, Recents, starring, renaming
 *    and the rest all work, and another copy of the editor on the same origin
 *    never sees them. Each page load gets its own folder; folders left by
 *    closed demo tabs are removed on the next load (a Web Lock tells open
 *    tabs from closed ones), so two demo tabs never clear each other's.
 *    localStorage is held in memory for the same reasons.
 *  - Two example projects, opened into that library on every load: the first
 *    is the one on screen, the other waits in Recents. No intro project.
 *  - A trimmed interface: no File menu (so no transcription, import, exports
 *    or downloads). NEW and Export media stay, so the demo shows what the
 *    editor can do, and say so when clicked: "not available in this demo".
 *  - Files dropped on the page are ignored.
 *
 * Kept to this one file (and two lines of index.html) so the branch stays
 * easy to bring up to date with main.
 */
(function () {
  // The example projects, relative to index.html. The first opens on load.
  const EXAMPLES = [
    'demo-examples/example-1.hyperaudio',
    'demo-examples/example-2.hyperaudio',
  ];
  // How long the page may wait for the examples before showing what it has.
  const EXAMPLES_TIMEOUT_MS = 15000;

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

  // --- a private library folder, one per page load ---------------------------
  const DEMO_ROOT = 'hyperaudio-demo';
  const loadId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const lockName = (id) => 'hyperaudio-demo:' + id;
  let demoDir = null;   // a promise of this load's folder
  if (navigator.locks && typeof navigator.locks.request === 'function') {
    // held for the life of the page: an open tab's folder is never tidied away
    navigator.locks.request(lockName(loadId), () => new Promise(() => {})).catch(() => {});
  }
  try {
    const realGetDirectory = StorageManager.prototype.getDirectory;
    if (typeof realGetDirectory === 'function') {
      StorageManager.prototype.getDirectory = function () {
        if (demoDir === null) {
          const storage = this;
          demoDir = (async () => {
            const root = await realGetDirectory.call(storage);
            const base = await root.getDirectoryHandle(DEMO_ROOT, { create: true });
            try {   // folders of demo tabs no longer open
              const locks = navigator.locks ? await navigator.locks.query() : { held: [], pending: [] };
              const inUse = new Set([...(locks.held || []), ...(locks.pending || [])].map((l) => l.name));
              for await (const [name] of base.entries()) {
                if (name !== loadId && !inUse.has(lockName(name))) {
                  await base.removeEntry(name, { recursive: true }).catch(() => {});
                }
              }
            } catch (e) { /* tidying is best-effort */ }
            return base.getDirectoryHandle(loadId, { create: true });
          })();
        }
        return demoDir;
      };
    }
  } catch (e) { /* no OPFS: the editor runs without a library, as it would anyway */ }

  // --- no service worker ----------------------------------------------------
  if ('serviceWorker' in navigator) {
    const folder = new URL('./', window.location.href).href;
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.filter((r) => r.scope.startsWith(folder)).forEach((r) => r.unregister());
    }).catch(() => {});
  }

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
    // the File menu: transcription, import, export and downloads alike
    '.dropdown:has(#file-dropdown)',
  ].join(',\n') + ' { display: none !important; }\n'
    // the intro text in the page stays hidden while the examples open
    + 'html.demo-starting #hypertranscript { visibility: hidden; }';
  document.head.appendChild(style);

  // --- NEW and Export media: shown, but not available -----------------------
  // Both are labels that open a dialog by checking its toggle; a click stopped
  // in the capture phase never reaches them, and says why instead.
  const UNAVAILABLE = {
    'new-transcription-btn': {
      title: 'Transcription isn\u2019t available in this demo',
      body: 'In the full editor you can transcribe audio and video in your browser, on your own computer, or with a cloud speech-to-text service.',
    },
    'export-media-btn': {
      title: 'Exporting isn\u2019t available in this demo',
      body: 'In the full editor you can export your edited audio or video, with captions burned in, in landscape, portrait or square.',
    },
  };
  const showUnavailable = (message) => {
    let toggle = document.getElementById('demo-unavailable-modal');
    if (toggle === null) {
      document.body.insertAdjacentHTML('beforeend',
        '<input type="checkbox" id="demo-unavailable-modal" class="modal-toggle" tabindex="-1" aria-hidden="true" />'
        + '<div class="modal" role="dialog" aria-labelledby="demo-unavailable-title">'
        + '<div class="modal-box" style="max-width:26rem">'
        + '<label for="demo-unavailable-modal" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">\u2715</label>'
        + '<h3 id="demo-unavailable-title" class="font-bold text-lg" style="margin-bottom:10px"></h3>'
        + '<p id="demo-unavailable-body"></p>'
        + '<div class="modal-action"><label for="demo-unavailable-modal" class="btn btn-primary">OK</label></div>'
        + '</div></div>');
      toggle = document.getElementById('demo-unavailable-modal');
      // a click outside the box closes it
      toggle.nextElementSibling.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) toggle.checked = false;
      });
    }
    document.getElementById('demo-unavailable-title').textContent = message.title;
    document.getElementById('demo-unavailable-body').textContent = message.body;
    toggle.checked = true;
  };
  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('#new-transcription-btn, #export-media-btn');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showUnavailable(UNAVAILABLE[button.id]);
  }, true);

  // --- the example projects -------------------------------------------------
  // No intro project: the editor seeds one only when the transcript carries a
  // data-intro-title, so the attribute goes before the editor starts. The
  // intro text itself stays in the page, as what shows if no example loads.
  document.documentElement.classList.add('demo-starting');
  const reveal = () => document.documentElement.classList.remove('demo-starting');
  setTimeout(reveal, EXAMPLES_TIMEOUT_MS);

  document.addEventListener('DOMContentLoaded', () => {
    const transcript = document.getElementById('hypertranscript');
    if (transcript !== null) transcript.removeAttribute('data-intro-title');
    openExamples().catch((e) => console.warn('[demo] the example projects could not be opened', e)).finally(reveal);
  });

  // The editor's boot has run once it has written its library index into
  // this load's folder; opening before then would race it.
  async function libraryReady() {
    if (demoDir === null) return false;
    try {
      const dir = await demoDir;
      const lib = JSON.parse(await (await (await dir.getFileHandle('library.json')).getFile()).text());
      return lib.introSeeded === true;
    } catch (e) {
      return false;
    }
  }

  async function openExamples() {
    const started = Date.now();
    while (!(window.HyperaudioSave && typeof window.HyperaudioSave.openFromFile === 'function'
        && await libraryReady())) {
      if (Date.now() - started > EXAMPLES_TIMEOUT_MS) throw new Error('the editor did not start in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    const files = await Promise.all(EXAMPLES.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(url + ': ' + response.status);
      return new File([await response.blob()], url.split('/').pop(), { type: 'application/zip' });
    }));
    // the last opened is the one on screen: open the first example last
    for (const file of files.slice().reverse()) {
      await window.HyperaudioSave.openFromFile(file);
    }
  }
})();

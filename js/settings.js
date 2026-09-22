/**
 * settings.js
 * (C) The Hyperaudio Project
 * @version 1.3.22 — last changed in release 1.3.22
 * @license MIT
 *
 * The settings modal (#615): the user's choices, as opposed to the project's.
 * The rule for what belongs here is whether it travels in the .hyperaudio —
 * Speakers, Timecodes and gap removal do, so they stay in the player row and
 * the format; nothing in here is ever written to a project.
 *
 * Two kinds of thing live here. Preferences (Playback): a matter of taste,
 * persisted under ONE localStorage key so they cannot sprawl. Escape hatches
 * (Application): the version, legibly; the storage the app occupies; ways
 * back from choices that were otherwise permanent — a "don't tell me again",
 * remembered API keys, and the editor's whole state.
 *
 * Downloaded models are the bulk of what the app stores (a Parakeet encoder
 * alone is ~1.2 GB) and had no way out short of clearing site data. The
 * engines that download them declare where, by pushing { engine, cacheName,
 * label(url) } onto window.HyperaudioModelStores; this module groups each
 * cache's entries by the engine's own labels, so every model is listed and
 * removable on its own, and knows no engine by name. Removal is cheap to get wrong — the
 * next local transcription downloads again — so it asks nothing first, and
 * it is deliberately separate from Reset, which keeps models: throwing away
 * a gigabyte of downloads is a different decision from throwing away work.
 *
 * Loads in the head, before editor-core, because the HyperaudioLite
 * instance reads a preference at construction; the DOM wiring waits for
 * DOMContentLoaded. Everything it touches in other modules goes through
 * their public surfaces (TranscribePrefs, HyperaudioSave, the model-store
 * registry), so removing this file removes the feature and nothing else.
 */

(function () {
  const KEY = 'hyperaudioSettings';
  const DEFAULTS = Object.freeze({
    playOnDoubleClick: false,   // a double-click moves the playhead; does it also play? (#441, #541)
    // Which reading rate the caption editor shows (#639): 'cps', 'wpm' or
    // 'none'. Characters per second is the streaming convention and the
    // stricter of the two, so it is the default; words per minute is what
    // broadcast works in. Clicking a rate switches between those two.
    captionRate: 'cps',
    // The longest a generated caption line should be. caption.js shipped with
    // 37; 32 reads more comfortably and is what the editor now generates to.
    captionLineLength: 32,
    // The reading rates past which a caption is flagged (#641). One per
    // measure, because the two do not convert cleanly: 17 is Netflix's figure
    // for English, 180 the upper end of broadcast practice.
    captionMaxCps: 17,
    captionMaxWpm: 180,
    // Colour the exported captions by speaker (#536). Off, because a voice
    // tag and a STYLE block are more than some caption tools accept, and
    // because SRT colour has no standard behind it at all.
    captionColourSpeakers: false,
    // Whether a new paragraph always starts a new caption (#661). Off: short
    // sentences share a caption across a paragraph break like any other.
    captionParagraphBreaks: false,
    // Transcript provenance files (#668, js/tpme.js). Off: nothing about them
    // is visible anywhere. Provider and Editor are about the person using the
    // editor, not a project, so they live here; with exports, whether the
    // export modal's option starts ticked.
    tpmeEnabled: false,
    tpmeProvider: '',
    tpmeEditor: '',
    tpmeWithExports: true,
    // FADGI's WebVTT metadata block in exported .vtt files (#673, js/tpme.js);
    // shown only with tpmeEnabled, since it uses the same Provider and Media ID
    fadgiEnabled: false,
    fadgiCountry: '',
  });

  // caption.js takes a maximum AND a minimum line length: the minimum is the
  // point past which a mid-sentence break is allowed, so a minimum at or above
  // the maximum makes a break impossible. The shipped 21 is kept wherever
  // there is room for it, and follows the maximum down when there is not.
  const CAPTION_LINE_MIN = 16;
  const CAPTION_LINE_MAX = 80;
  function captionLineLengths() {
    const raw = Number(readAll().captionLineLength);
    // blank, zero or nonsense means "the default", not "the smallest allowed":
    // an emptied field should give the value back, not the tightest wrap there is
    const max = Number.isFinite(raw) && raw > 0
      ? Math.min(CAPTION_LINE_MAX, Math.max(CAPTION_LINE_MIN, Math.round(raw)))
      : DEFAULTS.captionLineLength;
    return { max, min: Math.min(21, Math.max(8, max - 8)) };
  }

  // The sentence and paragraph rules every caption generation runs under
  // (#661, #662) — one answer for boot, Regenerate and the export fallback.
  // Abbreviations come from js/caption-abbreviations.js by language: the one
  // the project records, else the one its transcript reads as
  // (js/language-guess.js) — an engine asked to auto-detect records nothing,
  // and Parakeet (local) never records anything else — else the few titles
  // that belong to no language ("und"). With no data file at all, caption.js
  // is left with the rules that need no list.
  function transcriptText() {
    const root = typeof window.currentTranscriptRoot === 'function'
      ? window.currentTranscriptRoot() : document.getElementById('hypertranscript');
    if (root === null || root === undefined) return '';
    return [...root.querySelectorAll('[data-m]')]
      .filter((span) => !span.classList.contains('speaker'))
      .slice(0, 2000).map((span) => span.textContent).join(' ');
  }
  function captionLanguage(language) {
    if (language === undefined) {
      const save = window.HyperaudioSave;
      language = save && typeof save.getProjectLanguage === 'function' ? save.getProjectLanguage() : '';
    }
    const code = String(language || '').toLowerCase().split(/[-_]/)[0];
    if (code !== '') return code;
    return typeof window.guessTranscriptLanguage === 'function' ? window.guessTranscriptLanguage(transcriptText()) : '';
  }
  function captionOptions(language) {
    const lists = window.HyperaudioCaptionAbbreviations || {};
    const code = captionLanguage(language);
    const list = Array.isArray(lists[code]) ? lists[code] : (code === '' && Array.isArray(lists.und) ? lists.und : []);
    return {
      detectAbbreviations: true,
      abbreviations: list,
      joinSentences: true,
      paragraphBreaks: get('captionParagraphBreaks') === true,
      // #666: two speakers may share a caption, one per line, each line with
      // a hyphen (the paragraph setting above turns that off, since a speaker
      // label opens a paragraph); and a short sentence with nothing behind it
      // to join leads the long sentence after it.
      dualSpeakers: true,
      leadSentences: true,
    };
  }

  // Every "don't show this again" the app can persist. A flag added anywhere
  // else without being listed here is the trap #615 describes: dismissable
  // once, forever.
  const DISMISSAL_KEYS = Object.freeze([
    'noCaptionAlert',           // the captions-diverged warning (editor-core, #506)
  ]);

  // Every localStorage key the app writes, for Reset. Listed rather than
  // localStorage.clear(): an embedder shares the origin's storage and its
  // keys are not ours to remove.
  const APP_STORAGE_KEYS = Object.freeze([
    KEY,
    ...DISMISSAL_KEYS,
    'hyperaudioTranscribePrefs',  // transcribe-prefs.js
    'hyperaudioExportOptions',    // media-export.js (#616)
    'hyperaudioIonospherePublish', // transcript-to-ionosphere.js: the remembered handle (#346)
    'hyperaudioHasProjects',      // hyperaudio-save.js boot hint (#473)
    'hyperaudioWorkPresent',      // retired hint, removed on sight
  ]);

  // The engines' model caches, as declared (#615). Read at call time: the
  // engine modules load after this one.
  const modelStores = () => (Array.isArray(window.HyperaudioModelStores) ? window.HyperaudioModelStores : [])
    .filter((s) => s && typeof s.cacheName === 'string' && s.cacheName !== '');

  // A cached entry's model name, from the store's own labeller; the engine
  // name when it offers none. Grouping by this is what lets one Whisper size
  // go while another stays. A labeller answering null marks the entry as
  // ANCILLARY — a runtime cached beside the models — which is counted but
  // never listed, and goes with the last model.
  const labelOf = (store, url) => {
    if (typeof store.label !== 'function') return String(store.engine || store.cacheName);
    try {
      const l = store.label(url);
      if (l === null) return null;
      return typeof l === 'string' && l !== '' ? l : String(store.engine || store.cacheName);
    } catch (e) {
      return String(store.engine || store.cacheName);
    }
  };

  // Every downloaded model as { store, label, bytes, entries }, plus the
  // ancillary bytes, sized from the responses' own lengths. A response
  // without a length is read for its size — its Blob, not its bytes, so a
  // gigabyte entry does not pass through memory.
  async function measureModels() {
    const models = [];
    let ancillaryBytes = 0;
    if (typeof caches === 'undefined') return { models, ancillaryBytes };
    for (const store of modelStores()) {
      const groups = new Map();
      try {
        if (!(await caches.has(store.cacheName))) continue;
        const cache = await caches.open(store.cacheName);
        for (const req of await cache.keys()) {
          const res = await cache.match(req);
          if (!res) continue;
          const declared = Number(res.headers.get('content-length'));
          const size = Number.isFinite(declared) && declared > 0 ? declared : (await res.blob()).size;
          const label = labelOf(store, req.url);
          if (label === null) { ancillaryBytes += size; continue; }
          const g = groups.get(label) || { store, label, bytes: 0, entries: 0 };
          g.bytes += size;
          g.entries += 1;
          groups.set(label, g);
        }
      } catch (e) { /* an unreadable cache counts as empty */ }
      models.push(...groups.values());
    }
    models.sort((a, b) => a.label.localeCompare(b.label));
    return { models, ancillaryBytes };
  }

  // Remove one model: every entry of its store that carries its label. Once
  // no MODEL remains, the store's cache goes whole — ancillary files
  // included — so an emptied engine is indistinguishable from one that
  // never downloaded.
  async function removeModel(cacheName, label) {
    if (typeof caches === 'undefined') return;
    const store = modelStores().find((s) => s.cacheName === cacheName);
    if (!store) return;
    try {
      const cache = await caches.open(cacheName);
      let modelsLeft = 0;
      for (const req of await cache.keys()) {
        const l = labelOf(store, req.url);
        if (l === label) await cache.delete(req);
        else if (l !== null) modelsLeft += 1;
      }
      if (modelsLeft === 0) await caches.delete(cacheName);
    } catch (e) { /* already gone */ }
  }

  async function removeModels() {
    if (typeof caches === 'undefined') return;
    for (const store of modelStores()) {
      try { await caches.delete(store.cacheName); } catch (e) { /* already gone */ }
    }
  }

  function readAll() {
    try {
      const stored = JSON.parse(localStorage.getItem(KEY));
      return Object.assign({}, DEFAULTS, stored && typeof stored === 'object' ? stored : {});
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function get(name) {
    return readAll()[name];
  }
  function set(name, value) {
    const all = readAll();
    all[name] = value;
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) { /* private mode */ }
  }

  const byId = (id) => document.getElementById(id);

  const dismissedCount = () => DISMISSAL_KEYS.filter((k) => {
    try { return localStorage.getItem(k) !== null; } catch (e) { return false; }
  }).length;

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '?';
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + ' GB';
    if (n >= 1e6) return Math.round(n / 1e6) + ' MB';
    return Math.max(1, Math.round(n / 1e3)) + ' kB';
  }

  // The modal's Application rows describe live state, so they are refreshed
  // every time it opens rather than once at load.
  async function refresh() {
    // "v1.3.14 · 2 Sep 2026" — the release date is what a user needs to
    // say which build they have; between releases the tree says so.
    const version = byId('settings-app-version');
    const meta = document.querySelector('meta[name="version"]');
    const dateMeta = document.querySelector('meta[name="release-date"]');
    if (version !== null) {
      const date = dateMeta !== null && dateMeta.content ? new Date(dateMeta.content + 'T00:00:00') : null;
      const dateText = date !== null && !Number.isNaN(date.getTime())
        ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
        : 'unreleased';
      version.textContent = meta !== null ? 'v' + meta.content + ' · ' + dateText : '';
    }

    const undismiss = byId('settings-undismiss');
    const undismissHint = byId('settings-undismiss-hint');
    const n = dismissedCount();
    if (undismiss !== null) undismiss.disabled = n === 0;
    if (undismissHint !== null) undismissHint.textContent = n === 0 ? 'None dismissed.' : (n === 1 ? 'One is hidden.' : n + ' are hidden.');

    const forget = byId('settings-forget-keys');
    const forgetHint = byId('settings-forget-keys-hint');
    const prefs = window.TranscribePrefs;
    const has = !!(prefs && typeof prefs.hasRememberedKeys === 'function' && prefs.hasRememberedKeys());
    if (forget !== null) forget.disabled = !has;
    if (forgetHint !== null) forgetHint.textContent = has ? 'Stored in this browser, in plain text.' : 'None stored.';

    const modelsHint = byId('settings-models-hint');
    const modelsList = byId('settings-models');
    if (modelsHint !== null && modelsList !== null) {
      const { models, ancillaryBytes } = await measureModels();
      const total = models.reduce((sum, m) => sum + m.bytes, 0) + ancillaryBytes;
      modelsHint.textContent = models.length === 0
        ? 'None downloaded.'
        : formatBytes(total) + ' in all. A removed model is downloaded again when next needed.';
      modelsList.textContent = '';
      models.forEach((m) => {
        const li = document.createElement('li');
        li.dataset.cache = m.store.cacheName;
        li.dataset.label = m.label;
        const name = document.createElement('span');
        name.textContent = m.label;
        const size = document.createElement('span');
        size.className = 'settings-model-size';
        size.textContent = formatBytes(m.bytes);
        name.appendChild(size);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-xs btn-outline';
        btn.textContent = 'Remove';
        btn.setAttribute('aria-label', 'Remove ' + m.label);
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          await removeModel(m.store.cacheName, m.label);
          refresh();
        });
        li.appendChild(name);
        li.appendChild(btn);
        modelsList.appendChild(li);
      });
    }

    const storage = byId('settings-storage');
    if (storage !== null) {
      // The whole origin, which is the honest figure: projects and their
      // media, plus any local models the transcription engines have cached.
      try {
        const est = await navigator.storage.estimate();
        storage.textContent = 'Using ' + formatBytes(est.usage) + ' of the ' + formatBytes(est.quota)
          + ' this browser allows, including any downloaded local models.';
      } catch (e) {
        storage.textContent = 'This browser does not report storage use.';
      }
    }
  }

  function wire() {
    const toggle = byId('setting-play-on-dblclick');
    if (toggle !== null) {
      toggle.checked = get('playOnDoubleClick') === true;
      toggle.addEventListener('change', () => {
        set('playOnDoubleClick', toggle.checked);
        // live, on the running instance; editor-core reads the stored value
        // at every re-init so it also survives a transcript reload
        if (window.hyperaudioInstance) window.hyperaudioInstance.playOnClick = toggle.checked;
      });
    }

    const rate = byId('setting-caption-rate');
    if (rate !== null) {
      const known = (value) => (['cps', 'wpm', 'none'].indexOf(value) === -1 ? 'cps' : value);
      rate.value = known(get('captionRate'));
      rate.addEventListener('change', () => {
        set('captionRate', known(rate.value));
        // the caption editor may be open behind the modal
        if (typeof window.updateCaptionRates === 'function') window.updateCaptionRates();
      });
    }

    const colourSpeakers = byId('setting-caption-colour-speakers');
    if (colourSpeakers !== null) {
      colourSpeakers.checked = get('captionColourSpeakers') === true;
      colourSpeakers.addEventListener('change', () => {
        set('captionColourSpeakers', colourSpeakers.checked);
      });
    }

    const paragraphBreaks = byId('setting-caption-paragraph-breaks');
    if (paragraphBreaks !== null) {
      paragraphBreaks.checked = get('captionParagraphBreaks') === true;
      paragraphBreaks.addEventListener('change', () => {
        set('captionParagraphBreaks', paragraphBreaks.checked);
      });
    }

    const lineLength = byId('setting-caption-line-length');
    if (lineLength !== null) {
      lineLength.value = String(captionLineLengths().max);
      lineLength.addEventListener('change', () => {
        const typed = String(lineLength.value).trim();
        const asked = typed === '' ? NaN : Number(typed);
        const clamped = Number.isFinite(asked) && asked > 0
          ? Math.min(CAPTION_LINE_MAX, Math.max(CAPTION_LINE_MIN, Math.round(asked)))
          : DEFAULTS.captionLineLength;
        set('captionLineLength', clamped);
        lineLength.value = String(clamped);   // show what was actually taken
      });
    }

    [['setting-caption-max-cps', 'captionMaxCps', 1, 60], ['setting-caption-max-wpm', 'captionMaxWpm', 20, 400]]
      .forEach(([id, key, low, high]) => {
        const field = byId(id);
        if (field === null) return;
        field.value = String(get(key));
        field.addEventListener('change', () => {
          const typed = String(field.value).trim();
          const asked = typed === '' ? NaN : Number(typed);
          const clamped = Number.isFinite(asked) && asked > 0
            ? Math.min(high, Math.max(low, Math.round(asked)))
            : DEFAULTS[key];
          set(key, clamped);
          field.value = String(clamped);
          if (typeof window.updateCaptionRates === 'function') window.updateCaptionRates();
        });
      });

    const modal = byId('settings-modal');
    if (modal !== null) modal.addEventListener('change', () => { if (modal.checked) refresh(); });

    const undismiss = byId('settings-undismiss');
    if (undismiss !== null) {
      undismiss.addEventListener('click', () => {
        DISMISSAL_KEYS.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } });
        refresh();
      });
    }

    const forget = byId('settings-forget-keys');
    if (forget !== null) {
      forget.addEventListener('click', () => {
        if (window.TranscribePrefs && typeof window.TranscribePrefs.forgetKeys === 'function') {
          window.TranscribePrefs.forgetKeys();
        }
        refresh();
      });
    }

    const reset = byId('settings-reset');
    if (reset !== null) {
      reset.addEventListener('click', async () => {
        const save = window.HyperaudioSave;
        if (!save || typeof save.dialog !== 'function' || typeof save.resetEverything !== 'function') return;
        const ok = await save.dialog(
          'Every project in this browser is removed, including anything not exported, along with your remembered '
          + 'settings and API keys. The intro comes back, as on first run.\n\n'
          + 'Local transcription models already downloaded are kept.',
          { title: 'Reset the editor?', warning: true, danger: true, confirmLabel: 'Reset everything', cancelLabel: 'Keep everything' }
        );
        if (ok !== true) return;
        reset.disabled = true;
        await save.resetEverything();
        APP_STORAGE_KEYS.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } });
        location.reload();
      });
    }
  }

  // The limit for whichever measure is showing, or null when rates are off.
  // A limit of zero or less means "do not flag", which is how someone keeps
  // the number without the judgement.
  function captionRateLimit() {
    const all = readAll();
    const measure = ['cps', 'wpm', 'none'].indexOf(all.captionRate) === -1 ? 'cps' : all.captionRate;
    if (measure === 'none') return null;
    const raw = Number(measure === 'wpm' ? all.captionMaxWpm : all.captionMaxCps);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return { measure, limit: raw };
  }

  window.HyperaudioSettings = Object.freeze({
    get, set, DISMISSAL_KEYS, APP_STORAGE_KEYS, refresh,
    measureModels, removeModel, removeModels, captionLineLengths, captionRateLimit, captionOptions,
  });
  window.captionOptions = captionOptions;
  window.captionRateLimit = captionRateLimit;
  // The caption generators reach this by name, as they do the other shared
  // helpers: one place decides how long a generated line may be.
  window.captionLineLengths = captionLineLengths;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

/**
 * transcribe-prefs.js
 * (C) The Hyperaudio Project
 * @version 0.8.1 — last changed in release 0.8.1
 * @license MIT
 *
 * Remembers the Transcribe modal's choices across sessions (#390): the
 * Local/Cloud service switch, the selected engine tab in each group, each
 * engine's model / language / options, and the cloud API keys. Also wires the
 * standard show/hide "eye" toggle on the key fields.
 *
 * The keys live in localStorage in plain text — same trust model as pasting a
 * bring-your-own key into the page at all; convenient for a personal tool, and
 * the user can clear site data to remove them.
 */

(function () {
  const PREFS_KEY = 'hyperaudioTranscribePrefs';

  // Text/selse inputs persisted by value. Models are restored before languages
  // (Deepgram repopulates its language list from the chosen model).
  const MODEL_IDS = ['language-model', 'assemblyai-model', 'model-name-input'];
  const VALUE_IDS = ['token', 'assemblyai-key', 'language', 'assemblyai-language'];
  const CHECK_IDS = ['assemblyai-diarize', 'deepgram-remember-key', 'assemblyai-remember-key'];
  // A key is only persisted while its "remember" toggle is on (opt-out).
  const REMEMBER_MAP = { 'token': 'deepgram-remember-key', 'assemblyai-key': 'assemblyai-remember-key' };

  const byId = (id) => document.getElementById(id);

  function savePrefs() {
    const prefs = { values: {}, checks: {} };
    prefs.serviceMode = byId('service-cloud') && byId('service-cloud').checked ? 'cloud' : 'local';
    const localEngine = document.querySelector('input[name="local_tabs"]:checked');
    const cloudEngine = document.querySelector('input[name="cloud_tabs"]:checked');
    if (localEngine) prefs.localEngine = localEngine.getAttribute('aria-label');
    if (cloudEngine) prefs.cloudEngine = cloudEngine.getAttribute('aria-label');
    [...MODEL_IDS, ...VALUE_IDS].forEach((id) => {
      const el = byId(id);
      if (!el) return;
      // don't persist a key whose "remember" toggle is off
      const remId = REMEMBER_MAP[id];
      if (remId) { const rem = byId(remId); if (rem && !rem.checked) return; }
      prefs.values[id] = el.value;
    });
    CHECK_IDS.forEach((id) => { const el = byId(id); if (el) prefs.checks[id] = el.checked; });
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  }

  function restorePrefs() {
    let prefs;
    try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY)); } catch (e) { return; }
    if (!prefs) return;

    // service switch (the CSS reacts to :checked to show the right group)
    const modeEl = byId(prefs.serviceMode === 'cloud' ? 'service-cloud' : 'service-local');
    if (modeEl) modeEl.checked = true;

    // engine tab within each group
    const selectTab = (name, label) => {
      if (!label) return;
      const r = document.querySelector(`input[name="${name}"][aria-label="${label}"]`);
      if (r) r.checked = true;
    };
    selectTab('local_tabs', prefs.localEngine);
    selectTab('cloud_tabs', prefs.cloudEngine);

    const vals = prefs.values || {};
    // keys + models first; dispatch change on models so dependent language lists
    // repopulate before we set the saved language
    ['token', 'assemblyai-key'].forEach((id) => { const el = byId(id); if (el && vals[id] != null) el.value = vals[id]; });
    MODEL_IDS.forEach((id) => {
      const el = byId(id);
      if (el && vals[id] != null && hasOption(el, vals[id])) {
        el.value = vals[id];
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    VALUE_IDS.forEach((id) => {
      if (id === 'token' || id === 'assemblyai-key') return; // already set
      const el = byId(id);
      if (el && vals[id] != null && (el.tagName !== 'SELECT' || hasOption(el, vals[id]))) el.value = vals[id];
    });
    (prefs.checks ? Object.keys(prefs.checks) : []).forEach((id) => { const el = byId(id); if (el) el.checked = !!prefs.checks[id]; });

    // let each engine re-evaluate its TRANSCRIBE button now the key is filled in
    ['token', 'assemblyai-key', 'assemblyai-media', 'deepgram-media'].forEach((id) => {
      const el = byId(id);
      if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  const hasOption = (select, value) =>
    select.tagName !== 'SELECT' || Array.from(select.options).some((o) => o.value === value);

  function wireSaveListeners() {
    const ids = ['service-local', 'service-cloud', ...MODEL_IDS, ...VALUE_IDS, ...CHECK_IDS];
    ids.forEach((id) => {
      const el = byId(id);
      if (el && !el.dataset.prefWired) {
        el.dataset.prefWired = '1';
        el.addEventListener('change', savePrefs);
        if (el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'radio') el.addEventListener('input', savePrefs);
      }
    });
    document.querySelectorAll('input[name="local_tabs"], input[name="cloud_tabs"]').forEach((el) => {
      if (!el.dataset.prefWired) { el.dataset.prefWired = '1'; el.addEventListener('change', savePrefs); }
    });
  }

  // Standard show/hide eye toggle on any `.key-field` (password input + button).
  function wireKeyEyes() {
    document.querySelectorAll('.key-eye').forEach((btn) => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => {
        const input = btn.parentElement.querySelector('input');
        if (!input) return;
        const reveal = input.type === 'password';
        input.type = reveal ? 'text' : 'password';
        const open = btn.querySelector('.eye-open');
        const closed = btn.querySelector('.eye-closed');
        if (open) open.style.display = reveal ? 'none' : '';
        if (closed) closed.style.display = reveal ? '' : 'none';
        btn.setAttribute('aria-label', reveal ? 'Hide key' : 'Show key');
      });
    });
  }

  function init() {
    wireKeyEyes();
    restorePrefs();
    wireSaveListeners();
  }

  // Engine custom elements render their templates synchronously as the body is
  // parsed, so by DOMContentLoaded the fields exist; a 0ms defer is belt-and-braces.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  } else {
    setTimeout(init, 0);
  }
})();

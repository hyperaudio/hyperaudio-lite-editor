/**
 * tpme.js
 * (C) The Hyperaudio Project
 * @version 1.3.22 — last changed in release 1.3.22
 * @license MIT
 *
 * Transcript provenance sidecars (#668): how a transcript came to be — which
 * engine and model made it, with what settings, whether a person corrected
 * it, and who — written as a file beside the transcripts and captions the
 * editor exports.
 *
 * The vocabulary is Transcript Provenance Metadata Elements v1.0 (AI4LAM
 * Speech-to-Text Working Group, doi:10.5281/zenodo.21287085, CC0). TPME
 * defines element names and meanings and leaves the file format as a "local
 * implementation choice", so the file format here is the one concrete
 * precedent there is, the AAPB application profile: a JSON file whose top
 * level is an ARRAY of entries, one entry per step in the transcript's
 * history, ordered by modification_date rather than position, named
 * <media id>-tpme-YYYYMMDD-HHMMSS.json, and merged with others by
 * concatenating, dropping duplicates, and checking that media_id agrees.
 * Where that profile and v1.0 differ, v1.0 wins: the parameters element is
 * application_parameters.
 *
 * The editor is two of the steps TPME describes — the ASR step when it
 * transcribes, the "transcript editor" step when someone corrects — and a
 * third, format conversion, when it writes captions from a transcript nobody
 * has touched. A transcript that arrives with a history keeps it: imported
 * entries are passed through untouched and the editor's are appended, chained
 * by parent_transcript_id.
 *
 * OFF BY DEFAULT. With Settings → Provenance off, nothing here is visible:
 * no fields, no menu items, no export option. What the engines ran IS
 * recorded in every project regardless (hyperaudio-save.js) — TPME's first
 * design goal is to capture what "may not be capturable later", and a project
 * transcribed with this off must still describe itself fully once it is on.
 *
 * Self-contained: this file injects its own Settings tab, Info fields, File
 * menu items and export option. Removing it removes the feature. The first
 * half is pure, and exported for unit tests.
 */
(function () {
  const EDITOR_NAME = 'Hyperaudio Lite Editor';
  const EDITOR_PROVIDER = 'The Hyperaudio Project';
  const EDITOR_REPO = 'https://github.com/hyperaudio/hyperaudio-lite-editor';

  // TPME v1.0 provides no vocabulary for human_review_level and asks each
  // organisation to adopt one. These are the AAPB profile's, the only list
  // there is; anything else the user types is written as typed.
  const REVIEW_LEVELS = Object.freeze([
    'machine-generated', 'third-party-unknown', 'third-party-corrected',
    'partially-corrected', 'crowd-corrected', 'staff-corrected',
  ]);

  // What ran the inference, by the engine name a project records. Cloud
  // services have no version anyone outside can know; the profile's answer
  // for that is the literal "UNKNOWN", unless the service reported one.
  const ENGINES = [
    [/deepgram/i, { name: 'Deepgram', provider: 'Deepgram', repo: 'https://developers.deepgram.com' }],
    [/assemblyai/i, { name: 'AssemblyAI', provider: 'AssemblyAI', repo: 'https://www.assemblyai.com/docs' }],
    [/parakeet.*(huggingface|cloud)/i, { name: 'Hugging Face Inference Providers (Together)', provider: 'Hugging Face', repo: 'https://huggingface.co/docs/inference-providers' }],
    [/whisper/i, { name: 'transformers.js', provider: 'Hugging Face', repo: 'https://github.com/huggingface/transformers.js' }],
    [/parakeet/i, { name: 'onnxruntime-web', provider: 'Microsoft', repo: 'https://github.com/microsoft/onnxruntime' }],
  ];

  const clean = (entry) => {
    const out = {};
    Object.keys(entry).forEach((key) => {
      const v = entry[key];
      if (v === undefined || v === null || v === '') return;
      if (Array.isArray(v) && v.length === 0) return;
      if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0 && key !== 'application_parameters') return;
      out[key] = v;
    });
    return out;
  };

  // "2026-09-21T14:02:30.123Z" -> "20260921-140230", in UTC so two machines
  // name the same moment the same way
  function stamp(iso) {
    const d = new Date(iso);
    const at = Number.isNaN(d.getTime()) ? new Date() : d;
    const p = (n) => String(n).padStart(2, '0');
    return `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
  }

  const safeName = (text) => String(text || '').normalize('NFC')
    .replace(/[\/\\:*?"<>|#%&{}$!'`+=@]+/g, '').replace(/\s+/g, '_').replace(/^[._-]+|[._-]+$/g, '');

  function fileName(mediaId, iso) {
    return `${safeName(mediaId) || 'transcript'}-tpme-${stamp(iso)}.json`;
  }

  // Has a person changed the words? The engine's transcript as it first
  // arrived is kept beside the project, so this is a comparison, not a guess:
  // different words, or a word struck out. Timings moving is not review.
  // null when there is nothing to compare against.
  function wasEdited(originalWords, currentWords) {
    if (!Array.isArray(originalWords) || originalWords.length === 0 || !Array.isArray(currentWords)) return null;
    if (currentWords.some((w) => w && w.struck === true)) return true;
    const text = (words) => words.map((w) => String((w && w.text) || '').trim()).filter((t) => t !== '').join(' ');
    return text(originalWords) !== text(currentWords);
  }

  // The user's word for it when they have given one. Otherwise only what can
  // be known: untouched machine output is machine-generated, edited output is
  // at least partially corrected, and a transcript with no engine and no
  // original to compare is somebody else's, state unknown.
  function reviewLevel({ chosen, edited, hasEngine }) {
    if (typeof chosen === 'string' && chosen.trim() !== '') return chosen.trim();
    if (edited === true) return 'partially-corrected';
    if (edited === false || hasEngine) return 'machine-generated';
    return 'third-party-unknown';
  }

  const languages = (tag) => (typeof tag === 'string' && tag !== '' ? [tag] : []);

  // SHA-256 of a file, as "sha256:…". WebCrypto hashes a whole buffer at once
  // and has no streaming form, so a large file — a .hyperaudio with a
  // recording inside — would be held in memory twice at the moment an export
  // already holds the most. Above the limit it is left out, and the entry
  // SAYS so: in a provenance record a missing checksum reads as an oversight
  // unless it is explained. The limit is a round number, not a measurement;
  // hashing in slices would remove it, and is the proper fix (#670).
  const CHECKSUM_LIMIT_BYTES = 64 * 1024 * 1024;
  const megabytes = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;
  async function checksumOf(blob, limit) {
    const cap = typeof limit === 'number' ? limit : CHECKSUM_LIMIT_BYTES;
    const subtle = typeof globalThis !== 'undefined' && globalThis.crypto ? globalThis.crypto.subtle : undefined;
    if (subtle === undefined) {
      return { checksum: '', note: 'transcript_checksum omitted: SHA-256 is not available to this page (it needs a secure origin).' };
    }
    if (blob.size > cap) {
      return { checksum: '', note: `transcript_checksum omitted: the file is ${megabytes(blob.size)}, more than the ${megabytes(cap)} this editor hashes in one piece.` };
    }
    const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
    return { checksum: 'sha256:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''), note: '' };
  }

  function asrEntry(state) {
    const p = state.provenance;
    if (!p || !(p.engine || p.model || p.modelId)) return null;
    const known = (ENGINES.find(([pattern]) => pattern.test(p.engine || '')) || [null, null])[1];
    const local = typeof p.runtime === 'string' && p.runtime !== '';
    const notes = [];
    if (local) notes.push(`Run in the browser by ${EDITOR_NAME}${state.generatorVersion ? ' ' + state.generatorVersion : ''}.`);
    if (p.device) notes.push(`Processing: ${p.device}.`);
    if (typeof p.seconds === 'number') notes.push(`Time taken: ${p.seconds}s.`);
    return clean({
      media_id: state.mediaId,
      media_title: state.title,
      transcript_id: `${state.mediaId}-asr`,
      modification_date: p.transcribedAt,
      provider: state.provider,
      type: 'transcript',
      file_format: 'JSON',
      features: { time_aligned: true, speaker_diarization: state.speakerDiarization === true },
      transcript_language: languages(state.language),
      media_language: languages(state.language),
      human_review_level: 'machine-generated',
      application_type: 'ASR',
      application_name: known !== null ? (local ? p.runtime : known.name) : (p.engine || ''),
      application_provider: known !== null ? known.provider : '',
      application_version: p.engineVersion || 'UNKNOWN',
      application_repo: known !== null ? known.repo : '',
      inference_model: p.modelId || p.model,
      application_parameters: p.parameters,
      originating_media_file: p.mediaFile || state.mediaFilename,
      processing_note: notes.join(' '),
    });
  }

  // The newest entry of a chain, by date — position means nothing (AAPB).
  function newest(entries) {
    return entries.reduce((best, e) => (best === null
      || String(e.modification_date || '') >= String(best.modification_date || '') ? e : best), null);
  }

  /**
   * Every entry for a set of exported files.
   * state: { mediaId, title, language, mediaFilename, provider, editor,
   *   generatorVersion, provenance, imported, reviewLevel (chosen),
   *   edited (true|false|null), speakerDiarization, maxLineChars, conventions }
   * outputs: [{ name, format, type, checksum, note }]  (note: why there is no checksum)
   * now: ISO datetime of this export
   */
  function buildEntries(state, outputs, now) {
    const imported = Array.isArray(state.imported) ? state.imported : [];
    const asr = asrEntry(state);
    const parent = asr !== null ? asr.transcript_id : ((newest(imported) || {}).transcript_id || '');
    const level = reviewLevel({ chosen: state.reviewLevel, edited: state.edited, hasEngine: asr !== null });
    const reviewed = level !== 'machine-generated';
    const ours = (Array.isArray(outputs) ? outputs : []).map((output) => clean({
      media_id: state.mediaId,
      media_title: state.title,
      transcript_id: output.name,
      parent_transcript_id: parent,
      transcript_checksum: output.checksum,
      modification_date: now,
      provider: state.provider,
      type: output.type,
      file_format: output.format,
      features: Object.assign({ time_aligned: output.timeAligned !== false, speaker_diarization: state.speakerDiarization === true },
        output.type === 'captions' && state.maxLineChars ? { max_line_chars: state.maxLineChars } : {}),
      conventions: state.conventions,
      transcript_language: languages(state.language),
      human_review_level: level,
      // correcting is a judgement; writing captions from untouched machine
      // output is a conversion, and says so
      application_type: state.edited === true || reviewed ? 'transcript editor' : 'format-conversion',
      application_name: EDITOR_NAME,
      application_version: state.generatorVersion || 'UNKNOWN',
      application_provider: EDITOR_PROVIDER,
      application_repo: EDITOR_REPO,
      human_agent: reviewed ? state.editor : '',
      processing_note: output.note,
    }));
    return imported.concat(asr !== null ? [asr] : [], ours);
  }

  // Order-insensitive identity for an entry, so the same step read from two
  // files is one step.
  const canonical = (value) => (Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : (value !== null && typeof value === 'object'
      ? '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
      : JSON.stringify(value)));

  function mergeEntries(a, b) {
    const seen = new Set();
    return (a || []).concat(b || []).filter((entry) => {
      const key = canonical(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // A TPME file as read: an array of entries, or (v1.0's first example) one
  // entry on its own. Entries are kept exactly as they came — unknown
  // elements, local spellings and all: this is somebody else's record.
  function parseFile(text) {
    let json;
    try { json = JSON.parse(text); } catch (e) { throw new Error('This is not a JSON file.'); }
    const list = Array.isArray(json) ? json : [json];
    const entries = list.filter((e) => e !== null && typeof e === 'object' && !Array.isArray(e));
    if (entries.length === 0 || entries.length !== list.length) {
      throw new Error('A TPME file is a list of entries, each an object; this one is not.');
    }
    const recognised = entries.some((e) => ['media_id', 'modification_date', 'application_name', 'human_review_level', 'transcript_id']
      .some((key) => Object.prototype.hasOwnProperty.call(e, key)));
    if (!recognised) throw new Error('None of the TPME elements appear in this file.');
    return entries;
  }

  const mediaIds = (entries) => [...new Set((entries || []).map((e) => e.media_id).filter((id) => typeof id === 'string' && id !== ''))];

  const pure = { REVIEW_LEVELS, CHECKSUM_LIMIT_BYTES, stamp, fileName, wasEdited, reviewLevel, checksumOf, asrEntry, buildEntries, mergeEntries, parseFile, mediaIds };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof document === 'undefined') return;

  /* ==========================================================================
   * Browser: settings, fields, menu items, the export option
   * ======================================================================== */

  const settings = () => window.HyperaudioSettings;
  const save = () => window.HyperaudioSave;
  const setting = (key) => (settings() && typeof settings().get === 'function' ? settings().get(key) : undefined);
  const enabled = () => setting('tpmeEnabled') === true;
  const text = (key) => (typeof setting(key) === 'string' ? setting(key).trim() : '');

  // What an export needs, read in one go and detached, so a project opened or
  // edited while the encoder runs cannot reach the file (#656).
  function capture() {
    const s = save();
    const root = typeof window.currentTranscriptRoot === 'function'
      ? window.currentTranscriptRoot() : document.getElementById('hypertranscript');
    const spans = root ? [...root.querySelectorAll('[data-m]')] : [];
    const tpme = s && typeof s.getTpme === 'function' ? s.getTpme() : {};
    const provenance = s && typeof s.getProvenance === 'function' ? s.getProvenance() : null;
    const title = s && typeof s.getProjectTitle === 'function' ? s.getProjectTitle() : '';
    const mediaFilename = (provenance && provenance.mediaFile) || title;
    const lines = typeof window.captionLineLengths === 'function' ? window.captionLineLengths() : null;
    const versionMeta = document.querySelector('meta[name="version"]');
    const gaps = typeof window.getGapRemovalSettings === 'function' ? window.getGapRemovalSettings() : null;
    return {
      enabled: enabled(),
      wanted: enabled() && (document.getElementById('export-tpme') || {}).checked === true,
      projectId: s && s.library ? s.library.currentId() : null,
      mediaId: tpme.mediaId || String(mediaFilename || 'transcript').replace(/\.[a-z0-9]+$/i, ''),
      title: String(title || '').replace(/\.[a-z0-9]+$/i, ''),
      language: s && typeof s.getProjectLanguage === 'function' ? s.getProjectLanguage() : '',
      mediaFilename,
      provider: text('tpmeProvider'),
      editor: text('tpmeEditor'),
      generatorVersion: versionMeta !== null ? versionMeta.content : '',
      provenance,
      imported: Array.isArray(tpme.entries) ? tpme.entries : [],
      reviewLevel: tpme.reviewLevel || '',
      speakerDiarization: spans.some((span) => span.classList.contains('speaker')),
      maxLineChars: lines ? lines.max : undefined,
      gapsRemoved: !!(gaps && gaps.enabled),
      currentWords: spans.filter((span) => !span.classList.contains('speaker')).map((span) => ({
        text: span.textContent, struck: (span.style.textDecoration || '').includes('line-through'),
      })),
    };
  }

  // Which of an export's files are transcripts or captions, and what TPME calls them.
  const DESCRIBED = [
    [/\.vtt$/i, { format: 'text/vtt', type: 'captions' }],
    [/\.srt$/i, { format: 'SRT', type: 'captions' }],
    [/-transcript\.html$/i, { format: 'text/html', type: 'transcript' }],
    [/\.hyperaudio$/i, { format: 'application/vnd.hyperaudio+zip', type: 'transcript' }],
  ];

  async function entriesFor(snapshot, files, options) {
    const s = save();
    const original = snapshot.projectId !== null && s && typeof s.originalTranscriptFor === 'function'
      ? await s.originalTranscriptFor(snapshot.projectId) : null;
    const conventions = [];
    if (options && options.struckRemoved) conventions.push('struck_words_removed');
    if (snapshot.gapsRemoved && options && options.struckRemoved) conventions.push('silences_removed');
    const outputs = [];
    for (const file of files) {
      const described = (DESCRIBED.find(([pattern]) => pattern.test(file.name)) || [null, null])[1];
      if (described === null) continue;
      outputs.push(Object.assign({ name: file.name }, await checksumOf(file.blob), described));
    }
    // nothing textual among the files: the transcript as the project holds it
    if (outputs.length === 0) {
      outputs.push({ name: `${snapshot.mediaId}-transcript`, format: 'JSON', type: 'transcript', checksum: '' });
    }
    const state = Object.assign({}, snapshot, {
      edited: wasEdited(original && original.words, snapshot.currentWords), conventions,
    });
    return buildEntries(state, outputs, new Date().toISOString());
  }

  // For the media export: one more output, from the snapshot taken at the click.
  async function sidecar(snapshot, files, options) {
    if (!snapshot || snapshot.wanted !== true) return null;
    const entries = await entriesFor(snapshot, files, options);
    const now = (entries[entries.length - 1] || {}).modification_date || new Date().toISOString();
    return {
      blob: new Blob([JSON.stringify(entries, null, 2) + '\n'], { type: 'application/json' }),
      name: fileName(snapshot.mediaId, now),
    };
  }

  async function downloadNow() {
    const snapshot = Object.assign(capture(), { wanted: true });
    const file = await sidecar(snapshot, [], {});
    if (file === null) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file.blob);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  const say = (message, title, warning) => (save() && typeof save().dialog === 'function'
    ? save().dialog(message, { title, warning: warning === true, cancelButton: false, confirmLabel: 'OK' })
    : Promise.resolve(true));

  async function importFile(file) {
    let entries;
    try {
      entries = parseFile(await file.text());
    } catch (e) {
      await say(e.message, 'Not a provenance file', true);
      return false;
    }
    const s = save();
    const current = s.getTpme();
    const ids = mediaIds(entries);
    const mine = current.mediaId || '';
    if (ids.length > 1 || (mine !== '' && ids.length === 1 && ids[0] !== mine)) {
      const go = await s.dialog(
        (ids.length > 1
          ? `This file describes more than one recording (${ids.join(', ')}).`
          : `This file is about "${ids[0]}", and this project's Media ID is "${mine}".`)
        + '\n\nProvenance belongs to one recording. Add it to this project anyway?',
        { title: 'A different recording?', warning: true, confirmLabel: 'Add anyway' });
      if (go !== true) return false;
    }
    const merged = mergeEntries(current.entries, entries);
    const added = merged.length - (Array.isArray(current.entries) ? current.entries.length : 0);
    if (!s.setTpme({ entries: merged, mediaId: mine || (ids.length === 1 ? ids[0] : '') })) {
      await say('This project is open for editing in another tab, so nothing was added here.', 'Read-only', true);
      return false;
    }
    fillInfo();
    await say(added === 0
      ? 'Every entry in that file was already part of this project\'s provenance.'
      : `${added} ${added === 1 ? 'entry' : 'entries'} added. They are kept as they are, and this editor's own entries are appended when you export.`,
    'Provenance added');
    return true;
  }

  /* ---- the interface, all of it injected here ----------------------------- */

  function injectSettings() {
    const tabs = document.querySelector('#settings-modal + .modal .settings-tabs');
    if (tabs === null || document.getElementById('settings-tab-provenance') !== null) return;
    tabs.insertAdjacentHTML('beforeend', `
      <input type="radio" name="settings-tab" id="settings-tab-provenance" class="tab" aria-label="Provenance" />
      <div class="tab-content settings-panel bg-base-100 border-base-300 rounded-box" id="settings-panel-provenance">
        <label class="settings-row settings-row-toggle" for="setting-tpme-enabled">
          <span class="settings-text">
            Write transcript provenance (TPME) files
            <span class="settings-hint">A small JSON file recording how a transcript was made and corrected, for archives that keep such records (AI4LAM TPME v1.0). Adds an export option, a File menu item, and two fields to a project's Info. Off, none of that appears.</span>
          </span>
          <input type="checkbox" id="setting-tpme-enabled" class="toggle toggle-primary" />
        </label>
        <label class="settings-row tpme-only" for="setting-tpme-provider">
          <span class="settings-text">
            Provider
            <span class="settings-hint">The organisation responsible for the transcripts, written the same way every time.</span>
          </span>
          <input id="setting-tpme-provider" type="text" class="input input-bordered input-sm" style="width:14rem" autocomplete="organization" />
        </label>
        <label class="settings-row tpme-only" for="setting-tpme-editor">
          <span class="settings-text">
            Editor
            <span class="settings-hint">Who corrects transcripts here: a name, a role or an email address. Written only into entries for transcripts a person has reviewed.</span>
          </span>
          <input id="setting-tpme-editor" type="text" class="input input-bordered input-sm" style="width:14rem" autocomplete="email" />
        </label>
      </div>`);
    const toggle = document.getElementById('setting-tpme-enabled');
    toggle.checked = enabled();
    toggle.addEventListener('change', () => { settings().set('tpmeEnabled', toggle.checked); apply(); });
    [['setting-tpme-provider', 'tpmeProvider'], ['setting-tpme-editor', 'tpmeEditor']].forEach(([id, key]) => {
      const field = document.getElementById(id);
      field.value = text(key);
      field.addEventListener('change', () => settings().set(key, field.value.trim()));
    });
  }

  function injectInfo() {
    const summary = document.querySelector('#info-modal + .modal #summary');
    if (summary === null || document.getElementById('project-tpme') !== null) return;
    summary.closest('.info-section').insertAdjacentHTML('beforebegin', `
      <div class="info-section tpme-only" id="project-tpme">
        <h4 class="info-section-label">Provenance</h4>
        <div class="info-rows">
          <label style="display:flex; align-items:center; gap:8px; margin-top:4px">
            <strong style="min-width:7.5rem">Media ID:</strong>
            <input id="tpme-media-id" type="text" class="input input-bordered input-sm" style="flex:1" placeholder="the recording's identifier in your collection" />
          </label>
          <label style="display:flex; align-items:center; gap:8px; margin-top:6px">
            <strong style="min-width:7.5rem">Human review:</strong>
            <input id="tpme-review-level" type="text" list="tpme-review-levels" class="input input-bordered input-sm" style="flex:1" placeholder="automatic" />
            <datalist id="tpme-review-levels">${REVIEW_LEVELS.map((v) => `<option value="${v}"></option>`).join('')}</datalist>
          </label>
          <p id="tpme-chain" style="opacity:0.7; font-size:85%; margin-top:6px"></p>
        </div>
      </div>`);
    [['tpme-media-id', 'mediaId'], ['tpme-review-level', 'reviewLevel']].forEach(([id, key]) => {
      const field = document.getElementById(id);
      field.addEventListener('change', () => {
        if (!save().setTpme({ [key]: field.value.trim() })) fillInfo();   // read-only: put it back
      });
    });
    document.getElementById('info-modal').addEventListener('change', fillInfo);
  }

  function fillInfo() {
    const s = save();
    if (!s || typeof s.getTpme !== 'function' || document.getElementById('project-tpme') === null) return;
    const tpme = s.getTpme();
    const owns = !s.library || typeof s.library.ownsCurrent !== 'function' || s.library.ownsCurrent();
    [['tpme-media-id', tpme.mediaId], ['tpme-review-level', tpme.reviewLevel]].forEach(([id, value]) => {
      const field = document.getElementById(id);
      field.value = value || '';
      field.disabled = !owns;
    });
    const count = Array.isArray(tpme.entries) ? tpme.entries.length : 0;
    document.getElementById('tpme-chain').textContent = count === 0 ? ''
      : `${count} earlier ${count === 1 ? 'entry' : 'entries'} imported with this transcript — kept as they are, and written out first.`;
  }

  function injectMenu() {
    if (document.getElementById('tpme-export-item') !== null) return;
    const exportList = document.querySelector('#file-export-submenu ul');
    const importList = document.querySelector('#file-import-submenu ul');
    if (exportList !== null) {
      exportList.insertAdjacentHTML('beforeend', '<li class="tpme-only"><a id="tpme-export-item">Transcript provenance (TPME .json)</a></li>');
      document.getElementById('tpme-export-item').addEventListener('click', () => { downloadNow().catch((e) => console.warn('tpme: export failed', e)); });
    }
    if (importList !== null) {
      importList.insertAdjacentHTML('beforeend', '<li class="tpme-only"><a id="tpme-import-item">Transcript provenance (TPME .json)</a></li>');
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'tpme-import-input';
      input.accept = '.json,application/json';
      input.hidden = true;
      // an empty title suppresses Chrome's "No file chosen" tooltip; the
      // label names the field for assistive technology (#402)
      input.title = '';
      input.setAttribute('aria-label', 'Import a transcript provenance (TPME) file');
      document.body.appendChild(input);
      document.getElementById('tpme-import-item').addEventListener('click', () => { input.value = ''; input.click(); });
      input.addEventListener('change', () => { if (input.files[0]) importFile(input.files[0]).catch((e) => console.warn('tpme: import failed', e)); });
    }
  }

  function injectExportOption() {
    const extras = document.getElementById('export-extras');
    if (extras === null || document.getElementById('export-tpme-row') !== null) return;
    // data-export-extra: media-export.js counts any such row among the extra
    // files, without knowing what this one is
    extras.insertAdjacentHTML('beforeend', `
      <label id="export-tpme-row" data-export-extra style="display:none; gap:10px; align-items:center; margin-top:14px; cursor:pointer">
        <input type="checkbox" id="export-tpme" class="toggle toggle-primary" />
        <span class="label-text">Download transcript provenance (TPME .json) — how these files were made</span>
      </label>`);
    const check = document.getElementById('export-tpme');
    check.checked = setting('tpmeWithExports') !== false;
    check.addEventListener('change', () => settings().set('tpmeWithExports', check.checked));
  }

  // One switch for all of it. The class hides every .tpme-only; the export
  // row is shown and hidden by hand because its siblings are, and tells the
  // export modal to count again.
  function apply() {
    const on = enabled();
    document.documentElement.classList.toggle('ha-tpme', on);
    const row = document.getElementById('export-tpme-row');
    if (row !== null) {
      row.style.display = on ? 'flex' : 'none';
      row.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (on) fillInfo();
  }

  function wire() {
    if (!settings() || !save()) return;
    const style = document.createElement('style');
    style.textContent = 'html:not(.ha-tpme) .tpme-only { display: none !important; }';
    document.head.appendChild(style);
    injectSettings();
    injectInfo();
    injectMenu();
    injectExportOption();
    apply();
    const modal = document.getElementById('export-modal');
    if (modal !== null) modal.addEventListener('change', () => { if (modal.checked) apply(); });
  }

  window.HyperaudioTpme = Object.freeze(Object.assign({}, pure, { enabled, capture, sidecar, entriesFor, downloadNow, importFile }));

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();

/*
 * ============================================================================
 * .hyperaudio PROJECT SAVE — format, container, OPFS working copy, UI
 * ============================================================================
 *
 * Implements the .hyperaudio format v1.2 (normative spec:
 * docs/hyperaudio-format.md — originated in issue #403). 1.1 added media.kind
 * "link" (remote media embedded when CORS allows, declared URL-only link
 * otherwise, reconciled on open per § 7.3); 1.2 adds media.kind "none",
 * writer-side envelope preservation (§ 8.1), and pins the media.path segment
 * rule, byte-measured caps and STORE-only media (§ 7.1, § 10.2, § 10.3).
 * The format in ten lines — a renamed ZIP; a working SAVE, never an export:
 *   mimetype                   first entry, STORE: "application/vnd.hyperaudio+zip"
 *   hyperaudio.json            source of truth: format version + media descriptor
 *                              + options + texts + provenance + transcript
 *   transcript.html            editor-native copy (compat + sanitized recovery)
 *   transcript.original.json   machine output, immutable, optional
 *   captions.vtt               MAY legitimately diverge from the transcript
 *                              (options.captions.updateFromTranscript: false)
 *   media/<original filename>  byte-for-byte, never re-encoded, STORE entry
 * JSON times in SECONDS (float), DOM in ms; defaults (space:true, struck:false)
 * not serialized; readers ignore unknown entries/fields and reject newer majors;
 * no API keys, no app preferences, no rendered artifacts in the container.
 *
 * Five internal layers; only the BRIDGE touches the editor's DOM:
 *   1. FORMAT     build/validate hyperaudio.json          (pure — node-testable)
 *   2. CONTAINER  zip/unzip via JSZip, whitelist-read     (pure — node-testable)
 *   3. OPFS       work/ = the exploded container, autosave, dirty state
 *   4. BRIDGE     gather() editor state / apply() a loaded project
 *   5. UI         menu items in #file-dropdown, hidden file input, boot restore
 *
 * The FORMAT and CONTAINER layers are exported for node --test and are the
 * pieces a native app would reuse.
 */

(function () {
  'use strict';

  const FORMAT_NAME = 'hyperaudio';
  const FORMAT_VERSION = '1.2'; // 1.2: kind "none", envelope preservation, pinned path/caps (spec § 8)
  const READER_MAJOR = 1;
  const CONTAINER_MIMETYPE = 'application/vnd.hyperaudio+zip';
  const FILE_EXTENSION = '.hyperaudio';

  const ENTRY = {
    mimetype: 'mimetype',
    json: 'hyperaudio.json',
    html: 'transcript.html',
    original: 'transcript.original.json',
    captions: 'captions.vtt',
  };
  const MEDIA_DIR = 'media/';

  // Reader security (spec § 10): cap on text entries before/after inflating
  // (anti zip-bomb — an hour of speech is hundreds of KB, 50 MB is generous).
  const TEXT_ENTRY_MAX_BYTES = 50 * 1024 * 1024;

  // App-side soft warning thresholds for zipping media in memory (JSZip buffers
  // the archive): warn, never block — a student must always be able to take
  // their work out of the browser.
  const LARGE_MEDIA_WARN_BYTES = 500 * 1024 * 1024;
  const LARGE_MEDIA_WARN_BYTES_LOWMEM = 200 * 1024 * 1024;

  const WORK_DIR = 'work';
  const APP_STATE_FILE = 'app-state.json';
  // Synchronous boot hint: OPFS can only be probed async, so the autosave
  // maintains this flag and boot reads it before deciding to restore.
  const WORK_HINT_KEY = 'hyperaudioWorkPresent';

  /* ==========================================================================
   * 1. FORMAT — build/validate hyperaudio.json (pure)
   * ======================================================================== */

  // "major.minor" → {ok, major, minor, code?}. Malformed versions and majors
  // above the reader's are not loadable (ignore-unknown / reject-major, § 8).
  function checkFormatVersion(version) {
    if (typeof version !== 'string') return { ok: false, code: 'version-malformed' };
    const m = version.match(/^(\d+)\.(\d+)$/);
    if (m === null) return { ok: false, code: 'version-malformed' };
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    if (major > READER_MAJOR) return { ok: false, code: 'version-major', major, minor };
    return { ok: true, major, minor };
  }

  // media.path MUST be media/<filename>: exactly one non-empty segment, no
  // separators of either convention, and the segment must not be the exact
  // traversal tokens "." or ".." (spec § 10.2, pinned in 1.2). A ".."
  // SUBSTRING in a normal filename ("mix..final.mp3") is legal — rejecting it
  // made conforming containers written elsewhere unreadable.
  function validateMediaPath(path) {
    if (typeof path !== 'string' || path.indexOf(MEDIA_DIR) !== 0) return false;
    const segment = path.slice(MEDIA_DIR.length);
    if (segment === '' || /[/\\]/.test(segment)) return false;
    if (segment === '.' || segment === '..') return false;
    return true;
  }

  // Writer-side mirror of the same rule (spec § 10.2): one portable segment.
  // Used everywhere a filename becomes a media/ entry, an OPFS name, or a
  // descriptor path — writer and reader MUST share the rule.
  function sanitizeMediaFilename(name) {
    let out = String(name === null || name === undefined ? '' : name)
      .replace(/[/\\]/g, '_').trim();
    if (out === '' || out === '.' || out === '..') out = 'media';
    return out;
  }

  // Validate a parsed hyperaudio.json before use (spec § 10.4). Returns
  // {ok, errors: [{code, message}]}; the first error's code drives the reader's
  // behaviour (reject vs recovery, § 4).
  function validateProjectJson(project) {
    const errors = [];
    const fail = (code, message) => { errors.push({ code, message }); };

    if (project === null || typeof project !== 'object') {
      fail('unreadable', 'not a JSON object');
      return { ok: false, errors };
    }
    if (project.format !== FORMAT_NAME) {
      fail('format', 'format is not "hyperaudio"');
    }
    const version = checkFormatVersion(project.formatVersion);
    if (!version.ok) {
      fail(version.code, `formatVersion "${project.formatVersion}" is not loadable`);
    }

    const media = project.media;
    if (media === null || typeof media !== 'object') {
      fail('media', 'missing media descriptor');
    } else if (media.kind === 'original') {
      if (!validateMediaPath(media.path)) {
        fail('media-path', `media.path "${media.path}" violates the media/<filename> pattern`);
      }
    } else if (media.kind === 'link') {
      if (typeof media.url !== 'string' || !/^https?:/i.test(media.url)) {
        fail('media', 'media.kind "link" requires an http(s) url');
      }
    } else if (media.kind === 'none') {
      // a text-only project (spec § 7.2.2): nothing further to validate
    } else {
      fail('media-kind', `unknown media.kind "${media && media.kind}"`);
    }

    const transcript = project.transcript;
    if (transcript === null || typeof transcript !== 'object' || !Array.isArray(transcript.words)) {
      fail('transcript', 'missing transcript.words');
    } else {
      const badWord = transcript.words.find((w) =>
        w === null || typeof w !== 'object'
        || typeof w.text !== 'string'
        || !Number.isFinite(w.start) || !Number.isFinite(w.end)
        || w.start < 0 || w.end < w.start);
      if (badWord !== undefined) {
        fail('transcript', 'transcript.words contains an invalid word entry');
      }
      if (transcript.paragraphs !== undefined && !Array.isArray(transcript.paragraphs)) {
        fail('transcript', 'transcript.paragraphs is not an array');
      }
    }

    return { ok: errors.length === 0, errors };
  }

  // Assemble a complete hyperaudio.json object from gathered state. Defaults
  // (space: true, struck: false) are already omitted by htmlToJSON; times are
  // seconds throughout (the DOM's data-m/data-d are ms — ms = round(s × 1000)).
  function buildProjectJson(state) {
    // Round-trip preservation (spec § 8.1, normative since 1.2): start from
    // the opened envelope and overwrite only editor-owned fields — including
    // INSIDE known objects, where unknown keys are merged, not replaced.
    // Rebuilding from scratch destroyed the very fields readers are told to
    // ignore-and-tolerate.
    const base = state.envelope !== null && state.envelope !== undefined
      ? structuredClone(state.envelope) : {};
    const baseOptions = (base.options !== null && typeof base.options === 'object') ? base.options : {};
    const baseTexts = (base.texts !== null && typeof base.texts === 'object') ? base.texts : {};
    const project = Object.assign(base, {
      format: FORMAT_NAME,
      formatVersion: FORMAT_VERSION,
      generator: {
        name: 'hyperaudio-lite-editor',
        version: state.generatorVersion || '',
      },
      created: state.created,
      modified: state.modified,
      media: state.media,
      options: Object.assign({}, baseOptions, {
        gapRemoval: state.options.gapRemoval,
        captions: Object.assign({}, baseOptions.captions, { updateFromTranscript: state.options.updateCaptionsFromTranscript !== false }),
        view: Object.assign({}, baseOptions.view, state.options.view),
      }),
      texts: Object.assign({}, baseTexts, {
        title: state.texts.title || '',
        language: state.texts.language || '',
        summary: state.texts.summary || '',
        topics: Array.isArray(state.texts.topics) ? state.texts.topics : [],
      }),
      transcript: state.transcript,
    });
    if (state.provenance && (state.provenance.engine || state.provenance.model)) {
      project.provenance = Object.assign({}, state.provenance);
      if (state.hasOriginal) {
        project.provenance.originalTranscript = ENTRY.original;
      }
    }
    return project;
  }

  function serializeProjectJson(project) {
    return JSON.stringify(project, null, 2);
  }

  /* ==========================================================================
   * 2. CONTAINER — zip/unzip (pure; JSZip implementation injected)
   * ======================================================================== */

  // Build the container. files: {json, html, originalJson?, captionsVtt?,
  // media?: {name, data}}. The mimetype entry goes FIRST and STORED so the MIME
  // type sits at byte offset 38 (EPUB convention, § 2.1); the media entry is
  // STORED because media formats are already compressed.
  function zipProject(files, JSZipImpl, outType) {
    const zip = new JSZipImpl();
    zip.file(ENTRY.mimetype, CONTAINER_MIMETYPE, { compression: 'STORE' });
    zip.file(ENTRY.json, files.json);
    if (files.html) zip.file(ENTRY.html, files.html);
    if (files.originalJson) zip.file(ENTRY.original, files.originalJson);
    if (files.captionsVtt) zip.file(ENTRY.captions, files.captionsVtt);
    if (files.media) {
      zip.file(MEDIA_DIR + sanitizeMediaFilename(files.media.name), files.media.data, { compression: 'STORE', binary: true });
    }
    return zip.generateAsync({
      type: outType || 'uint8array',
      compression: 'DEFLATE',
      streamFiles: true,
    });
  }

  // Whitelist-read of a container (spec § 10.1): only entries with known names
  // are ever read; everything else is ignored. Returns {project, htmlText,
  // captionsVtt, originalText, mediaData, warnings} — or {recovered: true,
  // htmlText, ...} when hyperaudio.json is missing/unreadable but the HTML
  // compatibility copy can be used (spec § 4 recovery). Throws {code, message}
  // on rejection (version-major, media-kind, unreadable, entry-too-large).
  async function unzipProject(data, JSZipImpl) {
    const rejection = (code, message) => {
      const err = new Error(message);
      err.code = code;
      return err;
    };

    let zip;
    try {
      zip = await JSZipImpl.loadAsync(data);
    } catch (e) {
      throw rejection('unreadable', 'not a readable zip archive');
    }

    const warnings = [];

    async function readTextEntry(name) {
      const entry = zip.file(name);
      if (entry === null) return null;
      // Size cap before inflating when the metadata is available, and again
      // after as a backstop (spec § 10.3).
      const declared = entry._data && entry._data.uncompressedSize;
      if (typeof declared === 'number' && declared > TEXT_ENTRY_MAX_BYTES) {
        throw rejection('entry-too-large', `${name} exceeds the ${TEXT_ENTRY_MAX_BYTES} byte cap`);
      }
      const bytes = await entry.async('uint8array');
      if (bytes.byteLength > TEXT_ENTRY_MAX_BYTES) {
        throw rejection('entry-too-large', `${name} exceeds the ${TEXT_ENTRY_MAX_BYTES} byte cap`);
      }
      // The cap is UTF-8 BYTES and decoding is fatal (spec § 10.3, 1.2):
      // text.length counted UTF-16 units, so multibyte text could blow past
      // the cap, and invalid UTF-8 silently decoded to replacement characters
      // here while native readers rejected the same file.
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (e) {
        throw rejection('entry-invalid-utf8', `${name} is not valid UTF-8`);
      }
    }

    const mimetypeText = await readTextEntry(ENTRY.mimetype);
    if (mimetypeText === null) {
      warnings.push('missing mimetype entry (tolerated)');
    } else if (mimetypeText.trim() !== CONTAINER_MIMETYPE) {
      warnings.push('unexpected mimetype entry (tolerated)');
    }

    const htmlText = await readTextEntry(ENTRY.html);
    const captionsVtt = await readTextEntry(ENTRY.captions);
    const originalText = await readTextEntry(ENTRY.original);
    const jsonText = await readTextEntry(ENTRY.json);

    let project = null;
    if (jsonText !== null) {
      try {
        project = JSON.parse(jsonText);
      } catch (e) {
        project = null;
      }
    }

    const recover = (why) => {
      if (htmlText === null) {
        throw rejection('unreadable', why + ' and no transcript.html to recover from');
      }
      warnings.push(why + ' — recovered from transcript.html');
      return { recovered: true, project: null, htmlText, captionsVtt, originalText, mediaData: null, mediaEntryName: null, warnings };
    };

    if (project === null) {
      return recover('hyperaudio.json missing or unparseable');
    }

    const validation = validateProjectJson(project);
    if (!validation.ok) {
      const codes = validation.errors.map((e) => e.code);
      // reject-major and unknown media.kind are hard refusals (spec § 8, § 7.3)
      // — never silently recovered, the user needs the real message.
      if (codes.indexOf('version-major') !== -1) {
        throw rejection('version-major', 'this project requires a newer version of the editor');
      }
      if (codes.indexOf('media-kind') !== -1) {
        throw rejection('media-kind', 'this project uses a media format this editor does not support yet');
      }
      return recover('hyperaudio.json failed validation (' + codes.join(', ') + ')');
    }

    let mediaData = null;
    let mediaEntryName = null;
    if (project.media.kind === 'original') {
      const mediaEntry = zip.file(project.media.path);
      if (mediaEntry === null) {
        warnings.push('declared media entry is missing — media unavailable');
      } else {
        // spec § 7.1 (1.2): the media entry MUST be STORED — a compressed
        // media entry defeats § 10.3's size accounting. JSZip only exposes
        // the method via _data (private); the unit suite pins this so a
        // JSZip upgrade that moves it fails loudly, and absence of the
        // field fails open (no false rejections).
        const comp = mediaEntry._data && mediaEntry._data.compression;
        if (comp && comp.magic && comp.magic !== '\x00\x00') {
          throw rejection('media-compressed', 'the media entry is compressed; the format requires STORE');
        }
        mediaData = await mediaEntry.async('uint8array');
        mediaEntryName = project.media.path.slice(MEDIA_DIR.length);
      }
    }

    return { recovered: false, project, htmlText, captionsVtt, originalText, mediaData, mediaEntryName, warnings };
  }

  /* ==========================================================================
   * Exports for node --test (pure layers only), then browser-only code.
   * ======================================================================== */

  const pure = {
    FORMAT_NAME, FORMAT_VERSION, CONTAINER_MIMETYPE, ENTRY, MEDIA_DIR,
    TEXT_ENTRY_MAX_BYTES,
    checkFormatVersion, validateMediaPath, sanitizeMediaFilename, validateProjectJson,
    buildProjectJson, serializeProjectJson,
    zipProject, unzipProject,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = pure;
  }
  if (typeof document === 'undefined' || typeof navigator === 'undefined') {
    return; // node context: pure layers only
  }

  /* ==========================================================================
   * 3. OPFS — work/ is the exploded container; autosave; dirty state
   * ======================================================================== */

  const opfsAvailable = !!(navigator.storage && navigator.storage.getDirectory
    && typeof FileSystemFileHandle !== 'undefined'
    && FileSystemFileHandle.prototype.createWritable);

  async function getWorkDir(create) {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(WORK_DIR, { create: !!create });
  }

  async function writeFileTo(dir, name, data) {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function readTextFrom(dir, name) {
    try {
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return await file.text();
    } catch (e) {
      return null;
    }
  }

  async function readMediaFileFromWork(filename) {
    try {
      const dir = await getWorkDir(false);
      const mediaDir = await dir.getDirectoryHandle('media');
      const handle = await mediaDir.getFileHandle(filename);
      return await handle.getFile();
    } catch (e) {
      return null;
    }
  }

  async function clearWork() {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(WORK_DIR, { recursive: true });
    } catch (e) { /* nothing to clear */ }
    try { localStorage.removeItem(WORK_HINT_KEY); } catch (e) { /* private mode */ }
  }

  async function readAppState() {
    try {
      const root = await navigator.storage.getDirectory();
      const text = await readTextFrom(root, APP_STATE_FILE);
      return text !== null ? JSON.parse(text) : {};
    } catch (e) {
      return {};
    }
  }

  async function patchAppState(patch) {
    try {
      const root = await navigator.storage.getDirectory();
      const state = Object.assign(await readAppState(), patch);
      await writeFileTo(root, APP_STATE_FILE, JSON.stringify(state));
      return state;
    } catch (e) {
      return null;
    }
  }

  // The deterministic "dirty" rule (discussion doc § 13): work has been written
  // since the last .hyperaudio download. Download marking is optimistic — the
  // browser gives no completion signal for <a download>.
  async function isDirty() {
    if (!session.active) return false;
    const state = await readAppState();
    return (state.lastWorkWriteAt || 0) > (state.lastDownloadAt || 0);
  }

  /* ==========================================================================
   * 4. BRIDGE — the only layer that touches the editor's DOM
   * ======================================================================== */

  // Everything the module knows about the open project. Hydrated on new
  // transcript (hyperaudioInit), on open, and on boot restore.
  const session = {
    active: false,
    created: null,
    provenance: null,   // {engine, model, transcribedAt}
    provenanceAt: 0,    // when the engine reported it (staleness guard)
    language: '',
    mediaFile: null,    // the original File, captured at import
    mediaFileFromUrl: null, // set when mediaFile was fetched from this remote URL (embed, § 7.2)
    pendingReconcile: null, // media descriptor awaiting reconciliation (§ 7.3)
    hasOriginal: false,
    originalJson: null, // the origin as serialized JSON (in-memory copy; work/ holds it across reloads)
    title: '',          // project title; the legacy title field is gone (#439), so
                        // the session carries it across gather/apply (#449 adds UI)
    envelope: null,     // the opened project's raw parsed hyperaudio.json —
                        // rewrites start from it so unknown fields survive
                        // the round trip (spec § 8.1, normative since 1.2)
  };
  let suppressCapture = false; // true while apply() replays a loaded project
  // Synchronous "undownloaded changes" flag (#448's markEdited in embryo):
  // isDirty() is async (OPFS timestamps), but the Recents-switch guard must
  // decide inside a click handler. Set on every capture trigger and on a new
  // transcription; cleared on save-download, open, and session end.
  let sessionEdited = false;
  // Lifecycle guards (#448): generations decide whether an async completion
  // may still be applied; in-flight flags serialize container/snapshot work.
  let editGeneration = 0;      // bumps on every edit signal
  let identityGeneration = 0;  // bumps when a DIFFERENT document commits
  let saveInFlight = false;
  let autosaveInFlight = false;
  let autosaveFollowUp = false;
  let autosaveTimer = null;

  function nowIso() {
    return new Date().toISOString();
  }

  function getEditorHtml() {
    if (typeof getTranscriptData === 'function') {
      return getTranscriptData();
    }
    const el = document.querySelector('#hypertranscript');
    return el !== null ? el.innerHTML.replace(/ class=".*?"/g, '') : '';
  }

  function getCaptionsVtt() {
    const track = document.querySelector('#hyperplayer-vtt');
    if (track === null || !track.src || !track.src.startsWith('data:')) return '';
    try {
      return decodeURIComponent(track.src.split(',')[1] || '');
    } catch (e) {
      return '';
    }
  }

  function currentMediaDescriptor() {
    const player = document.querySelector('#hyperplayer');
    const duration = player && Number.isFinite(player.duration)
      ? Math.round(player.duration * 1000) / 1000 : 0;
    const src = player !== null ? player.src : '';
    if (/^https?:/i.test(src)) {
      // The player is on a remote URL (URL-mode transcription): a File captured
      // for a PREVIOUS project is stale — the URL wins. The exception is a file
      // fetched from this very URL (opportunistic embed, § 7.2): that IS this
      // project's media and the save is self-contained.
      if (session.mediaFile !== null && session.mediaFileFromUrl === src) {
        const safeName = sanitizeMediaFilename(session.mediaFile.name);
        return {
          kind: 'original',
          path: MEDIA_DIR + safeName,
          url: null,
          filename: safeName,
          mimeType: session.mediaFile.type || '',
          durationSeconds: duration,
          sizeBytes: session.mediaFile.size,
        };
      }
      return { kind: 'link', path: null, url: src, filename: '', mimeType: '', durationSeconds: duration, sizeBytes: 0 };
    }
    if (session.mediaFile !== null) {
      const safeName = sanitizeMediaFilename(session.mediaFile.name);
      return {
        kind: 'original',
        path: MEDIA_DIR + safeName,
        url: null,
        filename: safeName,
        mimeType: session.mediaFile.type || '',
        durationSeconds: duration,
        sizeBytes: session.mediaFile.size,
      };
    }
    if (src === '') {
      // No media at all (a text-only import): a "none" project (spec § 7.2.2)
      // — never a fabricated "original" descriptor pointing at nothing.
      return { kind: 'none', path: null, url: null, filename: '', mimeType: '', durationSeconds: 0, sizeBytes: 0 };
    }
    // Local media playing from a blob:/data: URL that we haven't captured yet
    // (e.g. a legacy Recents load) — resolveMediaFile() materialises it lazily.
    return { kind: 'original', path: MEDIA_DIR + 'media', url: null, filename: 'media', mimeType: '', durationSeconds: duration, sizeBytes: 0 };
  }

  // Make sure we hold the media as a File. Captured at import normally; for
  // blob:/data: sources (legacy loads) fetch the player source once and name
  // it from the MIME type.
  async function resolveMediaFile() {
    const player = document.querySelector('#hyperplayer');
    const src = player !== null ? player.src : '';
    // A remote URL in the player means URL-mode: any previously captured File
    // belongs to an older project and must not be saved as this one's media.
    if (!src || /^https?:/i.test(src)) return null;
    if (session.mediaFile !== null) return session.mediaFile;
    try {
      const blob = await (await fetch(src)).blob();
      const ext = (blob.type.split('/')[1] || 'bin').split(';')[0];
      session.mediaFile = new File([blob], 'media.' + ext, { type: blob.type });
      return session.mediaFile;
    } catch (e) {
      return null;
    }
  }

  // Snapshot the full editor state for the writer. Pure DOM reads; the media
  // bytes themselves are handled separately (write-once / resolve-on-demand).
  function gather() {
    const html = getEditorHtml();
    const transcript = htmlToJSON(html);
    const versionMeta = document.querySelector('meta[name="version"]');
    const titleField = document.querySelector('#project-title'); // #449's field, when present
    const summaryEl = document.getElementById('summary');
    const topicsEl = document.getElementById('topics');
    const media = currentMediaDescriptor();
    const title = (titleField !== null && titleField.value.trim() !== '')
      ? titleField.value.trim()
      : (session.title || media.filename || 'project');

    return {
      generatorVersion: versionMeta !== null ? versionMeta.content : '',
      envelope: session.envelope,
      created: session.created || nowIso(),
      modified: nowIso(),
      media,
      options: {
        gapRemoval: typeof window.getGapRemovalSettings === 'function'
          ? window.getGapRemovalSettings()
          : { enabled: false, thresholdMs: 500, bufferMs: 100 },
        updateCaptionsFromTranscript: typeof updateCaptionsFromTranscript !== 'undefined'
          ? updateCaptionsFromTranscript : true,
        view: {
          showSpeakers: !!(document.querySelector('#show-speakers') || {}).checked,
          showTimecodes: !!(document.querySelector('#show-timecodes') || {}).checked,
        },
      },
      texts: {
        title,
        language: session.language || '',
        summary: summaryEl !== null ? summaryEl.textContent.trim() : '',
        topics: topicsEl !== null
          ? topicsEl.textContent.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
          : [],
      },
      provenance: session.provenance,
      hasOriginal: session.hasOriginal,
      transcript,
      html,
    };
  }

  // Build the editor's transcript DOM from validated JSON — programmatically,
  // textContent only (spec § 10.5: never innerHTML on file data).
  function buildTranscriptDomFromJson(transcript) {
    const words = transcript.words || [];
    const paragraphs = (transcript.paragraphs && transcript.paragraphs.length > 0)
      ? transcript.paragraphs
      : [{ start: -Infinity, end: Infinity, speaker: null }];
    const article = document.createElement('article');
    const section = document.createElement('section');
    article.appendChild(section);

    paragraphs.forEach((paragraph) => {
      const p = document.createElement('p');
      const paragraphWords = words.filter((w) => w.start >= paragraph.start && w.start < paragraph.end);
      if (paragraph.speaker) {
        const speaker = document.createElement('span');
        speaker.className = 'speaker';
        speaker.setAttribute('data-m', String(Math.max(0, Math.round(paragraph.start * 1000))));
        speaker.setAttribute('data-d', '0');
        speaker.textContent = '[' + paragraph.speaker + '] ';
        p.appendChild(speaker);
      }
      paragraphWords.forEach((word) => {
        const startMs = Math.round(word.start * 1000);
        const span = document.createElement('span');
        span.setAttribute('data-m', String(startMs));
        span.setAttribute('data-d', String(Math.max(0, Math.round(word.end * 1000) - startMs)));
        if (word.struck === true) span.style.textDecoration = 'line-through';
        span.textContent = word.text + (word.space === false ? '' : ' ');
        p.appendChild(span);
      });
      if (p.childNodes.length > 0) section.appendChild(p);
    });
    return article;
  }

  // Recovery sanitiser for transcript.html (spec § 10.5): allowlist rebuild —
  // article/section/p/span, data-m/data-d integers, class "speaker", the
  // line-through style. Everything else is dropped.
  function sanitizeTranscriptHtml(htmlText) {
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');
    const article = document.createElement('article');
    const section = document.createElement('section');
    article.appendChild(section);
    doc.querySelectorAll('p').forEach((sourceP) => {
      const p = document.createElement('p');
      sourceP.querySelectorAll('span[data-m]').forEach((sourceSpan) => {
        const m = parseInt(sourceSpan.getAttribute('data-m'), 10);
        const d = parseInt(sourceSpan.getAttribute('data-d'), 10);
        if (!Number.isFinite(m) || m < 0) return;
        const span = document.createElement('span');
        span.setAttribute('data-m', String(m));
        span.setAttribute('data-d', String(Number.isFinite(d) && d >= 0 ? d : 0));
        if (sourceSpan.classList.contains('speaker')) span.className = 'speaker';
        if (/line-through/.test(sourceSpan.getAttribute('style') || '')) {
          span.style.textDecoration = 'line-through';
        }
        span.textContent = sourceSpan.textContent;
        p.appendChild(span);
      });
      if (p.childNodes.length > 0) section.appendChild(p);
    });
    return article;
  }

  // Replay a loaded project into the editor. Mirrors what the legacy
  // renderTranscript() does for Recents, but builds the DOM safely from JSON.
  function apply(loaded) {
    suppressCapture = true;
    try {
      // Loading always lands in transcript mode; leave caption mode first.
      if (typeof captionMode !== 'undefined' && captionMode === true) {
        const backBtn = document.querySelector('#transcript-editor-btn');
        if (backBtn !== null) backBtn.click();
      }

      const article = loaded.recovered
        ? sanitizeTranscriptHtml(loaded.htmlText)
        : buildTranscriptDomFromJson(loaded.project.transcript);
      const transcriptEl = document.querySelector('#hypertranscript');
      transcriptEl.replaceChildren(article);

      // Media: original file via an object URL; a "link" descriptor plays the
      // remote URL directly (degraded is declared by the caller's messaging).
      const player = document.querySelector('#hyperplayer');
      if (loaded.mediaFile) {
        player.src = URL.createObjectURL(loaded.mediaFile);
      } else if (!loaded.recovered && loaded.project.media.kind === 'link' && loaded.project.media.url) {
        player.src = loaded.project.media.url;
      }

      // Captions: fresh track (#356 stale-cue teardown), then the saved VTT.
      const track = resetCaptionTrack();
      const options = loaded.recovered ? null : loaded.project.options;
      if (typeof updateCaptionsFromTranscript !== 'undefined') {
        updateCaptionsFromTranscript = options && options.captions
          ? options.captions.updateFromTranscript !== false : true;
      }
      if (loaded.captionsVtt && track !== null) {
        track.src = 'data:text/vtt,' + encodeURIComponent(loaded.captionsVtt);
        track.kind = 'captions';
        if (player.textTracks[0] !== undefined) player.textTracks[0].mode = 'showing';
        const vttLink = document.querySelector('#download-vtt');
        if (vttLink !== null) vttLink.setAttribute('href', 'data:text/vtt,' + encodeURIComponent(loaded.captionsVtt));
        if (typeof populateCaptionEditorFromVtt === 'function') {
          if (typeof captionCache !== 'undefined') captionCache = null;
          populateCaptionEditorFromVtt(loaded.captionsVtt);
        }
      } else {
        document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
      }

      if (options !== null) {
        if (typeof window.applyGapRemovalSettings === 'function' && options.gapRemoval) {
          window.applyGapRemovalSettings(options.gapRemoval);
        }
        const view = options.view || {};
        const speakersToggle = document.querySelector('#show-speakers');
        if (speakersToggle !== null && typeof view.showSpeakers === 'boolean'
            && speakersToggle.checked !== view.showSpeakers) {
          speakersToggle.checked = view.showSpeakers;
          speakersToggle.dispatchEvent(new Event('change'));
        }
        const timecodesToggle = document.querySelector('#show-timecodes');
        if (timecodesToggle !== null && typeof view.showTimecodes === 'boolean'
            && timecodesToggle.checked !== view.showTimecodes) {
          timecodesToggle.checked = view.showTimecodes;
          timecodesToggle.dispatchEvent(new Event('change'));
        }
      }

      // Texts (clean data — textContent, never innerHTML on file data).
      const texts = loaded.recovered ? null : loaded.project.texts;
      const summaryEl = document.getElementById('summary');
      const topicsEl = document.getElementById('topics');
      if (summaryEl !== null) summaryEl.textContent = texts !== null ? (texts.summary || '') : '';
      if (topicsEl !== null) topicsEl.textContent = texts !== null ? (texts.topics || []).join(', ') : '';
      session.title = (texts !== null && texts.title) ? texts.title : '';
      const titleField = document.querySelector('#project-title');
      if (titleField !== null) titleField.value = session.title;

      const cleaned = transcriptEl.innerHTML.replace(/ class=".*?"/g, '');
      const htmlLink = document.querySelector('#download-html');
      if (htmlLink !== null) htmlLink.setAttribute('href', 'data:text/html,' + encodeURIComponent(cleaned));

      // Re-init playback/highlighting on the fresh transcript, same as the
      // legacy loaders do.
      hyperaudio();
      document.dispatchEvent(new CustomEvent('hyperaudioTranscriptLoaded'));
    } finally {
      suppressCapture = false;
    }
  }

  /* ==========================================================================
   * Project lifecycle: new project capture, autosave, save/open
   * ======================================================================== */

  async function writeWorkSnapshot() {
    if (!opfsAvailable || !session.active) return;
    // Serialize snapshots (#448): parallel writes could interleave files from
    // different states. An edit landing mid-write schedules ONE follow-up.
    if (autosaveInFlight) { autosaveFollowUp = true; return; }
    autosaveInFlight = true;
    const identityAtStart = identityGeneration;
    try {
      const state = gather();
      const dir = await getWorkDir(true);
      // One atomic-enough artifact (#448): json + html + captions in a single
      // file, so a crash can never leave a mixed-generation multi-file
      // snapshot. Absent captions are an explicit null — unambiguous. The
      // origin and media stay as separate immutable files.
      const vtt = getCaptionsVtt();
      await writeFileTo(dir, 'snapshot.json', JSON.stringify({
        json: serializeProjectJson(buildProjectJson(state)),
        html: state.html,
        captionsVtt: vtt !== '' ? vtt : null,
      }));
      // A completion for a superseded document must not be adopted (#448).
      if (identityGeneration === identityAtStart) {
        await patchAppState({ lastWorkWriteAt: Date.now() });
        try { localStorage.setItem(WORK_HINT_KEY, '1'); } catch (e) { /* private mode */ }
      }
    } catch (e) {
      console.warn('hyperaudio-save: autosave failed', e);
    } finally {
      autosaveInFlight = false;
      if (autosaveFollowUp) {
        autosaveFollowUp = false;
        if (identityGeneration === identityAtStart) writeWorkSnapshot();
      }
    }
  }

  function scheduleAutosave() {
    if (!session.active || suppressCapture) return;
    sessionEdited = true;
    editGeneration += 1;
    updateSaveIndicator();
    if (!opfsAvailable) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(writeWorkSnapshot, 1500);
  }

  async function writeMediaOnce() {
    if (!opfsAvailable || session.mediaFile === null) return;
    try {
      const dir = await getWorkDir(true);
      const mediaDir = await dir.getDirectoryHandle('media', { create: true });
      // one media per project: drop any previous file first
      for await (const name of mediaDir.keys()) {
        if (name !== session.mediaFile.name) await mediaDir.removeEntry(name).catch(() => {});
      }
      await writeFileTo(mediaDir, session.mediaFile.name, session.mediaFile);
    } catch (e) {
      console.warn('hyperaudio-save: media write failed', e);
    }
  }

  // The origin (spec § 5): written once when a project is born from a
  // transcription/import, immutable afterwards, never with struck flags.
  async function writeOriginOnce(transcript) {
    const clean = {
      words: (transcript.words || []).map((w) => {
        const word = { start: w.start, end: w.end, text: w.text };
        if (w.space === false) word.space = false;
        return word;
      }),
      paragraphs: transcript.paragraphs || [],
    };
    session.hasOriginal = true;
    session.originalJson = JSON.stringify(clean, null, 2);
    if (!opfsAvailable) return;
    try {
      const dir = await getWorkDir(true);
      await writeFileTo(dir, ENTRY.original, session.originalJson);
    } catch (e) {
      console.warn('hyperaudio-save: origin write failed', e);
    }
  }

  // A NEW project begins whenever a transcription or import lands a fresh
  // transcript (they all fire hyperaudioInit; legacy Recents loads call
  // hyperaudio() directly and do NOT, so they never overwrite the origin).
  async function onNewTranscript() {
    if (suppressCapture) return;
    const transcriptEl = document.querySelector('#hypertranscript');
    if (transcriptEl === null || transcriptEl.querySelector('span[data-m]') === null) return;
    session.active = true;
    session.created = nowIso();
    session.hasOriginal = false;
    session.mediaFileFromUrl = null;
    session.pendingReconcile = null;
    session.title = '';
    session.envelope = null; // a fresh document has no envelope to preserve
    sessionEdited = true;    // a fresh transcription IS undownloaded work
    identityGeneration += 1; // new document
    updateSaveIndicator();
    // Provenance is only this project's if the engine reported it moments ago
    // (imports fire hyperaudioInit without any setTranscriptionInfo call —
    // a previous transcription's provenance must not leak into them).
    if (Date.now() - session.provenanceAt > 120000) {
      session.provenance = null;
      session.language = '';
    }
    if (opfsAvailable) {
      await clearWork();
      await writeOriginOnce(htmlToJSON(getEditorHtml()));
      await resolveMediaFile();
      await writeMediaOnce();
      await writeWorkSnapshot();
    }
  }

  // Opportunistic embed (§ 7.2): try to download the remote media so the save
  // is self-contained. Whether this works is the server's call (CORS).
  async function fetchRemoteMediaFile(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    let name = '';
    try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch (e) { /* fallback below */ }
    if (name === '' || name.indexOf('.') === -1) {
      const ext = ((blob.type || '').split('/')[1] || 'bin').split(';')[0];
      name = (name || 'media') + '.' + ext;
    }
    return new File([blob], name, { type: blob.type || '' });
  }

  /* --------------------------------------------------------------------------
   * Designed dialogs — the app's daisyUI modal instead of native
   * alert()/confirm(): styled like the rest of the UI, non-blocking, keyboard
   * accessible (Enter/primary focused, Escape cancels). One shared element;
   * paragraphs split on blank lines. projectConfirm resolves true/false;
   * projectAlert resolves when dismissed.
   * ------------------------------------------------------------------------ */
  let dialogEl = null;
  function ensureDialog() {
    if (dialogEl !== null) return dialogEl;
    dialogEl = document.createElement('div');
    dialogEl.id = 'project-dialog';
    dialogEl.className = 'modal';
    dialogEl.setAttribute('role', 'dialog');
    dialogEl.setAttribute('aria-modal', 'true');
    dialogEl.innerHTML = '<div class="modal-box" style="position:relative">'
      + '<button type="button" id="project-dialog-close" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">✕</button>'
      + '<div id="project-dialog-message" style="line-height:1.6; margin-top:22px; padding-right:30px"></div>'
      + '<div class="modal-action">'
      + '<button type="button" id="project-dialog-cancel" class="btn btn-ghost">Cancel</button>'
      + '<button type="button" id="project-dialog-extra" class="btn btn-primary" style="display:none"></button>'
      + '<button type="button" id="project-dialog-confirm" class="btn btn-primary">OK</button>'
      + '</div></div>';
    document.body.appendChild(dialogEl);
    return dialogEl;
  }
  function projectDialog(message, opts) {
    opts = opts || {};
    const el = ensureDialog();
    const msg = el.querySelector('#project-dialog-message');
    msg.textContent = '';
    String(message).split('\n\n').forEach((para, i) => {
      const pEl = document.createElement('p');
      pEl.textContent = para;
      if (i > 0) pEl.style.marginTop = '12px';
      msg.appendChild(pEl);
    });
    const confirmBtn = el.querySelector('#project-dialog-confirm');
    const cancelBtn = el.querySelector('#project-dialog-cancel');
    const extraBtn = el.querySelector('#project-dialog-extra');
    confirmBtn.textContent = opts.confirmLabel || 'OK';
    cancelBtn.textContent = opts.cancelLabel || 'Cancel';
    cancelBtn.style.display = opts.cancel === false ? 'none' : '';
    extraBtn.textContent = opts.extraLabel || '';
    extraBtn.style.display = opts.extraLabel ? '' : 'none';
    // Two-button rule for the destructive triads: the ✕ (and Escape) IS the
    // cancel, so the explicit Cancel button can be dropped via cancelButton:false.
    if (opts.cancelButton === false) cancelBtn.style.display = 'none';
    // Destructive confirmations (work dies): the confirm goes btn-error red —
    // matching the Recents armed-delete convention — and the SAFE button takes
    // the default focus, so Enter through a half-read dialog cannot destroy.
    confirmBtn.className = opts.danger === true ? 'btn btn-error' : 'btn btn-primary';
    el.classList.add('modal-open');
    return new Promise((resolve) => {
      const closeBtn = el.querySelector('#project-dialog-close');
      const done = (result) => {
        el.classList.remove('modal-open');
        confirmBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        extraBtn.removeEventListener('click', onExtra);
        closeBtn.removeEventListener('click', onClose);
        document.removeEventListener('keydown', onKey, true);
        resolve(result);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onExtra = () => done('extra');
      const onClose = () => done(opts.cancel === false); // dismissing an OK-alert acknowledges it
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          done(opts.cancel === false);
        }
      };
      confirmBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      extraBtn.addEventListener('click', onExtra);
      closeBtn.addEventListener('click', onClose);
      document.addEventListener('keydown', onKey, true);
      // default focus: the safe-and-constructive extra (Save…) when present,
      // else Cancel for destructive dialogs, else the confirm
      (opts.extraLabel ? extraBtn : (opts.danger === true ? cancelBtn : confirmBtn)).focus();
    });
  }
  const projectAlert = (message) => projectDialog(message, { cancel: false });
  const projectConfirm = (message, confirmLabel, cancelLabel) =>
    projectDialog(message, { confirmLabel: confirmLabel, cancelLabel: cancelLabel });
  const projectConfirmDanger = (message, confirmLabel, cancelLabel) =>
    projectDialog(message, { confirmLabel: confirmLabel, cancelLabel: cancelLabel, danger: true });

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // The navbar Save button's dirty dot mirrors sessionEdited (#449).
  function updateSaveIndicator() {
    const btn = document.getElementById('project-save-btn');
    if (btn !== null) btn.classList.toggle('dirty', sessionEdited === true);
  }

  async function saveToFile() {
    if (saveInFlight) return false; // one container build at a time (#448)
    saveInFlight = true;
    try {
      return await saveToFileInner();
    } finally {
      saveInFlight = false;
    }
  }

  async function saveToFileInner() {
    const identityAtStart = identityGeneration;
    let mediaFile = await resolveMediaFile();
    const player = document.querySelector('#hyperplayer');
    const remoteSrc = player !== null && /^https?:/i.test(player.src) ? player.src : null;
    let saveAsLink = false;

    if (mediaFile === null && remoteSrc !== null) {
      if (session.mediaFile !== null && session.mediaFileFromUrl === remoteSrc) {
        mediaFile = session.mediaFile; // already embedded by a previous save of this project
      } else {
        try {
          mediaFile = await fetchRemoteMediaFile(remoteSrc);
          session.mediaFile = mediaFile;
          session.mediaFileFromUrl = remoteSrc;
          await writeMediaOnce(); // the working copy becomes self-contained too
        } catch (e) {
          // CORS or network said no: fall back to a link save (§ 7.2), declared.
          const proceed = await projectConfirm('The remote media cannot be downloaded by the browser (the server does not allow it), so it cannot be embedded in the file.\n\nSave the project with a LINK to the URL instead? The file will contain all your work, but playing it back will need internet access and the URL staying available.', 'Save with link', 'Cancel');
          if (!proceed) return false;
          saveAsLink = true;
        }
      }
    }
    if (mediaFile === null && !saveAsLink) {
      await projectAlert('No media loaded — there is nothing to save yet.');
      return false;
    }

    const lowMem = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 4;
    const warnAt = lowMem ? LARGE_MEDIA_WARN_BYTES_LOWMEM : LARGE_MEDIA_WARN_BYTES;
    if (mediaFile !== null && mediaFile.size > warnAt) {
      const mb = Math.round(mediaFile.size / (1024 * 1024));
      if (!(await projectConfirm(`The media file is large (~${mb} MB). Building the .hyperaudio file needs roughly that much memory and may take a while.`, 'Continue', 'Cancel'))) {
        return false;
      }
    }

    session.active = true;
    if (session.created === null) session.created = nowIso();

    const editAtGather = editGeneration;
    const state = gather();
    // The origin travels in every save (spec § 5): the in-memory copy is the
    // primary source (also covers browsers without OPFS); work/ carries it
    // across reloads.
    let originalJson = session.originalJson;
    if (originalJson === null && opfsAvailable) {
      try {
        originalJson = await readTextFrom(await getWorkDir(false), ENTRY.original);
      } catch (e) { /* no work dir yet */ }
    }
    state.hasOriginal = originalJson !== null;

    const JSZipImpl = await loadJSZip();
    const blob = await zipProject({
      json: serializeProjectJson(buildProjectJson(state)),
      html: state.html,
      originalJson,
      captionsVtt: getCaptionsVtt() || null,
      media: mediaFile !== null ? { name: mediaFile.name, data: mediaFile } : null,
    }, JSZipImpl, 'blob');

    const safeTitle = (state.texts.title || 'project')
      .replace(/\.hyperaudio$/i, '')
      .replace(/[\\/:*?"<>|]+/g, '-').trim() || 'project';
    const suggestedName = safeTitle + FILE_EXTENSION;

    // Native bridge hook (#449): an embedding app (a native wrapper with its
    // own filesystem access) registers window.hyperaudioProjectBridge before
    // load and receives the finished archive instead of a browser download —
    // one save path for web and native, no injected UI. Returning false
    // declines, and the browser download proceeds as the fallback.
    const bridge = window.hyperaudioProjectBridge;
    if (bridge && typeof bridge.save === 'function') {
      let handled = false;
      try {
        handled = (await bridge.save(blob, suggestedName)) !== false;
      } catch (e) {
        console.warn('hyperaudio-save: bridge save failed, falling back to download', e);
      }
      if (!handled) {
        triggerDownload(blob, suggestedName);
      }
    } else {
      triggerDownload(blob, suggestedName);
    }

    // Mark clean only if this save still belongs to the current document AND
    // no edit landed while the container was being built (#448) — otherwise
    // the download is real but the session stays dirty.
    if (identityGeneration === identityAtStart && editGeneration === editAtGather) {
      sessionEdited = false;
      updateSaveIndicator();
      await patchAppState({ lastDownloadAt: Date.now() });
    }
    return true;
  }

  async function openFromFile(file) {
    // Parse and validate BEFORE the replace-confirmation: asking permission
    // to replace the current project and THEN refusing the file meant the
    // user consented to a replacement that never happened (prepare → confirm
    // → apply, the #448 ordering).
    let loaded;
    try {
      const JSZipImpl = await loadJSZip();
      loaded = await unzipProject(file, JSZipImpl);
    } catch (e) {
      const messages = {
        'version-major': 'This project was saved by a newer version of the editor and cannot be opened here. Please update the editor.',
        'media-kind': 'This project uses a media formula this editor does not support yet. Please update the editor.',
        'entry-too-large': 'This file contains an oversized entry and was refused for safety.',
        'entry-invalid-utf8': 'This file contains invalid text encoding and was refused.',
        'media-compressed': 'This file stores its media compressed, which the format forbids — it was refused for safety.',
        'unreadable': 'This is not a readable .hyperaudio file.',
      };
      await projectAlert(messages[e.code] || messages['unreadable']);
      return;
    }

    if (await isDirty()) {
      const choice = await projectDialog('The current project has changes not yet saved as a .hyperaudio file. Opening a new project will DISCARD them.', {
        confirmLabel: 'Discard and open', danger: true, extraLabel: 'Save and open', cancelButton: false,
      });
      if (choice === false) return;
      if (choice === 'extra') {
        let saved = false;
        try { saved = await saveToFile(); } catch (e) { saved = false; }
        if (saved !== true) return; // the save was abandoned — replacing now would lose it
      }
    }

    // A legacy Recents doc may hold a pending debounced autosave — its last
    // edits must land before this open replaces the document.
    if (typeof flushRecentsAutosave === 'function') {
      try { flushRecentsAutosave(); } catch (e) { /* legacy module absent */ }
    }

    let reconcileNow = null; // § 7.3: original-kind container missing its media entry
    if (loaded.mediaData !== null && loaded.mediaEntryName !== null) {
      const mimeType = loaded.project !== null ? (loaded.project.media.mimeType || '') : '';
      loaded.mediaFile = new File([loaded.mediaData], loaded.mediaEntryName, { type: mimeType });
    } else {
      loaded.mediaFile = null;
      if (!loaded.recovered && loaded.project.media.kind === 'link') {
        await projectAlert('Note: this project references its media by URL — it is not self-contained. Playback will use the remote URL.');
      } else if (!loaded.recovered && loaded.project.media.kind === 'original') {
        reconcileNow = loaded.project.media;
      }
    }

    suppressCapture = true;
    try {
      apply(loaded);

      // Hydrate the session from the loaded project and seed work/ so the
      // autosave continues from here.
      session.active = true;
      session.created = (!loaded.recovered && loaded.project.created) || nowIso();
      session.provenance = (!loaded.recovered && loaded.project.provenance) || null;
      session.language = (!loaded.recovered && loaded.project.texts && loaded.project.texts.language) || '';
      session.mediaFile = loaded.mediaFile;
      session.mediaFileFromUrl = null;
      session.pendingReconcile = (!loaded.recovered && loaded.project.media.kind === 'link')
        ? loaded.project.media : null;
      session.hasOriginal = loaded.originalText !== null;
      session.originalJson = loaded.originalText;
      session.envelope = loaded.recovered ? null : loaded.project;
      sessionEdited = false; // the opened file IS the downloaded state
      identityGeneration += 1; // a different document now owns the session
      updateSaveIndicator();

      if (opfsAvailable) {
        await clearWork();
        const dir = await getWorkDir(true);
        if (loaded.originalText !== null) await writeFileTo(dir, ENTRY.original, loaded.originalText);
        await writeMediaOnce();
      }
    } finally {
      suppressCapture = false;
    }
    await writeWorkSnapshot();

    if (loaded.warnings.length > 0) {
      console.warn('hyperaudio-save: opened with warnings:', loaded.warnings);
      if (loaded.recovered) {
        await projectAlert('The project file was not fully conformant; the transcript was recovered from its HTML copy. Saving again will produce a fully conformant file.');
      }
    }

    if (reconcileNow !== null) {
      offerMediaReconciliation(reconcileNow);
    }
  }

  /* ==========================================================================
   * Media reconciliation (spec § 7.3): when a project's media is unavailable
   * (link URL unreachable, or an original-kind container missing its media
   * entry), offer to re-attach a local copy. Verification is heuristic — size
   * and filename when recorded, duration once metadata loads — and the next
   * save makes the project self-contained again (kind "original").
   * ======================================================================== */

  let reconcileTarget = null;
  let reconcileInput = null;

  async function offerMediaReconciliation(desc) {
    const why = desc.url
      ? 'The media URL this project points to cannot be played (offline, moved, or gone).'
      : 'The media file is missing from the project container.';
    const proceed = await projectConfirm(why + '\n\nThe text is loaded and editable. If you have the media on this computer you can re-attach it now — the next save will make the project self-contained again.', 'Choose media file', 'Not now');
    if (!proceed) return;
    reconcileTarget = desc;
    reconcileInput.value = '';
    reconcileInput.click();
  }

  async function attachReconciledMedia(file, desc) {
    const doubts = [];
    if (desc.sizeBytes > 0 && desc.sizeBytes !== file.size) doubts.push('its size differs from the saved project');
    if (desc.filename && desc.filename !== file.name) doubts.push('its name differs (project media was "' + desc.filename + '")');
    if (doubts.length > 0
        && !(await projectConfirm('This may not be the right file: ' + doubts.join('; ') + '.', 'Attach anyway', 'Cancel'))) {
      return;
    }
    const player = document.querySelector('#hyperplayer');
    session.mediaFile = file;
    session.mediaFileFromUrl = null;
    session.pendingReconcile = null;
    player.src = URL.createObjectURL(file);
    if (desc.durationSeconds > 0) {
      player.addEventListener('loadedmetadata', function check() {
        player.removeEventListener('loadedmetadata', check);
        if (Number.isFinite(player.duration) && Math.abs(player.duration - desc.durationSeconds) > 2) {
          projectAlert('Warning: the attached media lasts ~' + Math.round(player.duration) + 's but the project was saved with ~' + Math.round(desc.durationSeconds) + 's — it may be the wrong file.');
        }
      });
    }
    writeMediaOnce();
    scheduleAutosave();
  }

  // Boot restore: the synchronous localStorage hint decides whether to probe
  // OPFS at all; the static demo transcript in index.html is simply replaced.
  async function restoreFromWork() {
    try {
      const dir = await getWorkDir(false);
      // The snapshot is ONE file since #448 (torn multi-file states are
      // impossible); work dirs written before that carry the per-file layout —
      // read them as a fallback until they age out.
      let jsonText = null;
      let captionsVtt = null;
      const snapshotText = await readTextFrom(dir, 'snapshot.json');
      let snapshotHtml = null;
      if (snapshotText !== null) {
        try {
          const snapshot = JSON.parse(snapshotText);
          jsonText = typeof snapshot.json === 'string' ? snapshot.json : null;
          snapshotHtml = typeof snapshot.html === 'string' ? snapshot.html : null;
          captionsVtt = typeof snapshot.captionsVtt === 'string' ? snapshot.captionsVtt : null;
        } catch (e) {
          console.warn('hyperaudio-save: unreadable snapshot.json', e);
        }
      }
      if (jsonText === null) {
        jsonText = await readTextFrom(dir, ENTRY.json); // pre-#448 layout
        captionsVtt = await readTextFrom(dir, ENTRY.captions);
      }
      if (jsonText === null) {
        try { localStorage.removeItem(WORK_HINT_KEY); } catch (e) { /* ignore */ }
        return;
      }
      const project = JSON.parse(jsonText);
      const validation = validateProjectJson(project);
      if (!validation.ok) {
        console.warn('hyperaudio-save: work copy failed validation, leaving demo', validation.errors);
        try { localStorage.removeItem(WORK_HINT_KEY); } catch (e) { /* ignore */ }
        return;
      }
      const mediaFile = project.media.kind === 'original'
        ? await readMediaFileFromWork(project.media.filename) : null;
      const originalText = await readTextFrom(dir, ENTRY.original);

      apply({ recovered: false, project, captionsVtt, mediaFile });
      session.active = true;
      identityGeneration += 1; // the restored document owns the session
      session.created = project.created || nowIso();
      session.provenance = project.provenance || null;
      session.language = (project.texts && project.texts.language) || '';
      session.mediaFile = mediaFile;
      session.mediaFileFromUrl = null;
      session.pendingReconcile = project.media.kind === 'link' ? project.media : null;
      session.hasOriginal = originalText !== null;
      session.originalJson = originalText;
      session.envelope = project; // §8.1: a save after restore must preserve unknown fields too
    } catch (e) {
      console.warn('hyperaudio-save: restore failed, leaving demo', e);
    }
  }

  /* ==========================================================================
   * 5. UI — menu items, hidden input, wiring (self-injected)
   * ======================================================================== */

  let jszipPromise = null;
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (jszipPromise === null) {
      jszipPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'js/vendor/jszip-3.10.1.min.js';
        script.onload = () => resolve(window.JSZip);
        script.onerror = () => { jszipPromise = null; reject(new Error('failed to load JSZip')); };
        document.head.appendChild(script);
      });
    }
    return jszipPromise;
  }

  function injectUi() {
    const dropdown = document.querySelector('#file-dropdown');
    if (dropdown === null) return;
    dropdown.insertAdjacentHTML('beforeend',
      '<hr class="my-2 h-0 border border-t-0 border-solid border-neutral-700 opacity-25 dark:border-neutral-200" />'
      + '');
    // The navbar Save button covers saving (#449), so the menu carries no
    // Save item; opening a project lives with the other imports.
    const importList = document.querySelector('#file-exportimport-submenu ul');
    if (importList !== null) {
      importList.insertAdjacentHTML('afterbegin',
        '<li><a id="project-open-hyperaudio">Import Project (.hyperaudio)</a></li>');
    } else {
      dropdown.insertAdjacentHTML('beforeend',
        '<li><a id="project-open-hyperaudio">Import Project (.hyperaudio)</a></li>');
    }

    // Navbar Save button (#449), matching the native app's treatment exactly:
    // primary (Save leads the lifecycle cluster Save · Export · NEW — outline
    // belongs to the editing tools), placed before the export button, with a
    // primary-content dot ringed in primary while unsaved changes exist.
    const exportBtn = document.getElementById('export-media-btn');
    const navEnd = exportBtn !== null ? exportBtn.parentElement : document.querySelector('.navbar-end');
    if (navEnd !== null) {
      const saveBtn = document.createElement('button');
      saveBtn.id = 'project-save-btn';
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-square btn-primary relative tooltip';
      saveBtn.setAttribute('data-tip', 'Save project (⌘S)');
      saveBtn.setAttribute('aria-label', 'Save project');
      saveBtn.style.marginRight = '4px';
      saveBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-save" aria-hidden="true"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>'
        + '<span id="project-save-dirty-dot" aria-hidden="true"></span>';
      saveBtn.addEventListener('click', () => {
        saveToFile().catch((e) => projectAlert('Saving the project failed: ' + e.message));
      });
      if (exportBtn !== null) navEnd.insertBefore(saveBtn, exportBtn);
      else navEnd.appendChild(saveBtn);
    }

    // ⌘/Ctrl-S — the universal save gesture; capture phase beats the browser's
    // own save-page dialog.
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
          && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        saveToFile().catch((e) => projectAlert('Saving the project failed: ' + e.message));
      }
    }, true);

    // The quit guard (#449): warn only when the session holds unsaved work.
    // The prompt is the browser's own — beforeunload cannot show custom UI.
    window.addEventListener('beforeunload', (event) => {
      if (session.active && sessionEdited) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'project-open-input';
    input.accept = FILE_EXTENSION;
    input.style.display = 'none';
    input.title = ''; // #402: suppress the native "No file chosen" tooltip
    input.setAttribute('aria-label', 'Open a .hyperaudio project file');
    document.body.appendChild(input);

    reconcileInput = document.createElement('input');
    reconcileInput.type = 'file';
    reconcileInput.id = 'project-reconcile-input';
    reconcileInput.accept = 'audio/*,video/*';
    reconcileInput.style.display = 'none';
    reconcileInput.title = ''; // #402
    reconcileInput.setAttribute('aria-label', 'Locate the project’s media file');
    document.body.appendChild(reconcileInput);
    reconcileInput.addEventListener('change', () => {
      if (reconcileInput.files.length === 1 && reconcileTarget !== null) {
        attachReconciledMedia(reconcileInput.files[0], reconcileTarget);
        reconcileTarget = null;
      }
    });

    document.querySelector('#project-open-hyperaudio').addEventListener('click', () => {
      input.value = '';
      input.click();
    });
    input.addEventListener('change', () => {
      if (input.files.length === 1) {
        openFromFile(input.files[0]).catch((e) => {
          console.error('hyperaudio-save: open failed', e);
          projectAlert('Opening the project failed: ' + e.message);
        });
      }
    });
  }

  function wireCapture() {
    // The original media File, captured at the existing engine file inputs —
    // no engine code is touched.
    ['#file-input', '#parakeet-file-input', '#deepgram-file', '#assemblyai-file', '#parakeet-hf-file']
      .forEach((selector) => {
        const el = document.querySelector(selector);
        if (el === null) return;
        el.addEventListener('change', () => {
          if (el.files && el.files.length === 1) {
            session.mediaFile = el.files[0];
            session.mediaFileFromUrl = null;
          }
        });
      });

    // Reconciliation trigger for link projects (§ 7.3): the URL doesn't need
    // CORS to play, so reachability can only be judged by the player itself.
    const playerEl = document.querySelector('#hyperplayer');
    if (playerEl !== null) {
      playerEl.addEventListener('error', () => {
        const desc = session.pendingReconcile;
        if (desc === null || !desc.url || playerEl.src !== desc.url) return;
        session.pendingReconcile = null; // one shot
        offerMediaReconciliation(desc);
      });
    }

    // New transcript (transcribe / JSON / SRT import) → new project + origin.
    document.addEventListener('hyperaudioInit', () => {
      onNewTranscript().catch((e) => console.warn('hyperaudio-save: capture failed', e));
    });

    // A legacy Recents load replaces the document OUTSIDE the project system:
    // it fires hyperaudioTranscriptLoaded but not hyperaudioInit, and never
    // runs under our apply's suppressCapture. The project session must end —
    // a capture after the swap would write the Recents doc's content under
    // the OLD project's identity (a franken working copy, and a spurious
    // "changes never downloaded" warning on the next open). The boot hint
    // clears so a reload doesn't resurrect a project the user navigated away
    // from; work/ itself is left inert and the next session overwrites it.
    // Interim coexistence rule until #448 (identity generations) / #451
    // (legacy-storage removal).
    // Switching to a Recents doc discards the project session exactly like
    // Open Project replaces it — so it gets the same warning, cancelable at
    // capture phase BEFORE the legacy loader swaps the DOM. (Without this,
    // an edit made after the last save was silently discarded on switch.)
    let switchApproved = null; // the row whose next click was confirmed via the modal
    document.addEventListener('click', (event) => {
      if (!session.active || !sessionEdited) return;
      const target = event.target;
      if (!target || !target.closest || target.tagName === 'INPUT') return;
      const item = target.closest('.file-item');
      if (item === null) return;
      if (switchApproved === item) { switchApproved = null; return; } // the replay passes through
      // The modal is async but the click must be decided NOW — intercept
      // unconditionally, ask, and replay the click on confirmation.
      event.preventDefault();
      event.stopPropagation();
      projectDialog('The current project has changes not yet saved as a .hyperaudio file. Switching to a saved transcript will DISCARD them.', {
        confirmLabel: 'Discard and switch', danger: true, extraLabel: 'Save and switch', cancelButton: false,
      }).then(async (choice) => {
          if (choice === false) return;
          if (choice === 'extra') {
            let saved = false;
            try { saved = await saveToFile(); } catch (e) { saved = false; }
            if (saved !== true) return; // abandoned save — stay on the project
          }
          switchApproved = item;
          item.click();
        });
    }, true);

    document.addEventListener('hyperaudioTranscriptLoaded', () => {
      if (suppressCapture) return; // our own apply() also fires this event
      clearTimeout(autosaveTimer);
      session.active = false;
      session.title = '';
      sessionEdited = false;
      identityGeneration += 1; // the session's document is gone
      updateSaveIndicator();
      try { localStorage.removeItem(WORK_HINT_KEY); } catch (e) { /* private mode */ }
    });

    // Provenance: engines report service/model through setTranscriptionInfo.
    const originalSetInfo = window.setTranscriptionInfo;
    if (typeof originalSetInfo === 'function') {
      window.setTranscriptionInfo = function (info) {
        try {
          session.provenance = {
            engine: (info && info.service ? String(info.service) : '').toLowerCase(),
            model: info && info.model ? String(info.model) : '',
            transcribedAt: nowIso(),
          };
          session.provenanceAt = Date.now();
          session.language = info && info.language ? String(info.language) : session.language;
        } catch (e) { /* provenance is best-effort */ }
        return originalSetInfo.apply(this, arguments);
      };
    }

    // Central edit signal (#448), document-level delegation: the caption-mode
    // round trip REPLACES #hypertranscript, so direct element listeners died
    // after one switch and the autosave silently stopped. closest() finds the
    // current incarnation of each editable region.
    const EDIT_SCOPE = '#hypertranscript, #caption-editor, #summary, #topics, #project-title';
    document.addEventListener('input', (event) => {
      const t = event.target;
      if (t && t.closest && t.closest(EDIT_SCOPE) !== null) scheduleAutosave();
    }, true);
    // blur doesn't bubble; focusout does — end-of-edit capture for the transcript
    document.addEventListener('focusout', (event) => {
      const t = event.target;
      if (t && t.closest && t.closest('#hypertranscript') !== null) scheduleAutosave();
    });
    // the strike-through toolbar mutates word styles without emitting input
    const strikeBtn = document.querySelector('#strikethrough');
    if (strikeBtn !== null) strikeBtn.addEventListener('click', scheduleAutosave);
    document.addEventListener('hyperaudioGenerateCaptionsFromTranscript', scheduleAutosave);
    ['#remove-gaps-enabled', '#remove-gaps-threshold', '#remove-gaps-buffer', '#show-speakers', '#show-timecodes']
      .forEach((selector) => {
        const el = document.querySelector(selector);
        if (el !== null) {
          el.addEventListener('change', scheduleAutosave);
          el.addEventListener('input', scheduleAutosave);
        }
      });
  }

  function boot() {
    injectUi();
    wireCapture();
    let hint = null;
    try { hint = localStorage.getItem(WORK_HINT_KEY); } catch (e) { /* private mode */ }
    if (opfsAvailable && hint === '1') {
      restoreFromWork();
    }
  }

  // Expose a small public API for other modules / the console.
  window.HyperaudioSave = {
    saveToFile,
    openFromFile,
    autosaveNow: writeWorkSnapshot,
    isDirty,
    opfsAvailable,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/*
 * ============================================================================
 * .hyperaudio PROJECT SAVE — format, container, OPFS working copy, UI
 * ============================================================================
 *
 * @version 1.0.1 — last changed in release 1.0.1
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
 *   3. OPFS       the project library (#456): work/<projectId>/ per project
 *                 (saved.json committed by Save, draft.json autosave scratch,
 *                 origin, media), library.json index, per-project Web Locks.
 *                 Save is a SILENT OPFS commit; Export is the only download.
 *   4. BRIDGE     gather() editor state / apply() a loaded project
 *   5. UI         menu items in #file-dropdown, hidden file input, Save button,
 *                 boot restore of the most recently edited project
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
  // The project library (#456): every project lives in work/<projectId>/ and
  // library.json at the OPFS root is the index the side panel lists — {id,
  // name, starred, createdAt, modifiedAt, lastDraftAt, lastSavedAt, media
  // meta, summary, topics}. The index replaced the localStorage boot hint:
  // boot reads it and restores the most recently edited project.
  //
  // Each project dir holds TWO states, mirroring Glider's document model:
  //   saved.json  — the state the user last committed with Save (⌘S). Save is
  //                 a silent OPFS write, never a download; a future format
  //                 revision records each manual save as a version.
  //   draft.json  — the autosave scratch (Glider's RecoveryStore analog):
  //                 written debounced on edit so switching projects, crashes
  //                 and closes lose nothing, while the project honestly stays
  //                 DIRTY until a real Save. Deleted by Save.
  // transcript.original.json and media/ sit beside them, shared by both.
  // Taking a .hyperaudio OUT of the browser is a separate explicit Export —
  // the only path that downloads.
  const SAVED_FILE = 'saved.json';
  const DRAFT_FILE = 'draft.json';
  const LIBRARY_FILE = 'library.json';
  // Index writes are read-modify-write on one JSON file, so they serialize
  // under one origin-global Web Lock; each project's working copy has its own
  // per-project lock (#450's slot made per-project): the owning tab gets
  // autosave, another tab on the SAME project keeps full editing but no slot
  // (bannered honestly), and the lock's queue promotes it when the owner
  // closes or switches away. Two tabs on different projects both own theirs.
  const LIBRARY_LOCK = 'hyperaudio:library';
  const PROJECT_LOCK_PREFIX = 'hyperaudio:project:';
  // Pre-#456 single-slot layout (work/snapshot.json + root app-state.json):
  // never released — migrated into a project dir once, for dev working copies.
  const APP_STATE_FILE = 'app-state.json';

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

  // Strip class pollution from transcript markup (playback highlighting,
  // contenteditable artifacts) while KEEPING the semantic "speaker" class —
  // htmlToJSON identifies speaker labels by it (span[data-m]:not(.speaker)),
  // so the blanket class strip the editor's getTranscriptData() applies
  // demoted every speaker to a plain word on each save/autosave round trip:
  // paragraphs lost their speaker names and restored labels lost their
  // styling and the Speakers toggle.
  function sanitizeTranscriptClasses(html) {
    return String(html).replace(/ class="([^"]*)"/g, (match, classes) =>
      (/(?:^|\s)speaker(?:\s|$)/.test(classes) ? ' class="speaker"' : ''));
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

  /* --------------------------------------------------------------------------
   * Library index rules (#456) — pure, node-testable.
   * ------------------------------------------------------------------------ */

  // Panel order: last edited first, created date the fallback for entries
  // that have never been written to.
  function sortLibraryEntries(entries) {
    return entries.slice().sort((a, b) =>
      (b.modifiedAt || b.createdAt || 0) - (a.modifiedAt || a.createdAt || 0));
  }

  // The deterministic per-project "dirty" rule (#456, Glider-matched): a
  // draft has been written since the last manual Save. A never-saved project
  // (fresh transcription) is dirty; an opened .hyperaudio starts clean (the
  // file IS the saved state).
  function isEntryDirty(entry) {
    return (entry.lastDraftAt || 0) > (entry.lastSavedAt || 0);
  }

  // Identity is OPFS-native (#456): a generated id names the work/<id>/ dir
  // and the per-project lock — none of the file↔workdir matching hazards;
  // opening the same .hyperaudio twice simply makes two entries.
  function newProjectId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
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
    sanitizeTranscriptClasses,
    buildProjectJson, serializeProjectJson,
    sortLibraryEntries, isEntryDirty, newProjectId,
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

  async function getWorkRoot(create) {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(WORK_DIR, { create: !!create });
  }

  async function getProjectDir(id, create) {
    const work = await getWorkRoot(create);
    return work.getDirectoryHandle(id, { create: !!create });
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

  async function readMediaFileFromProject(id, filename) {
    try {
      const dir = await getProjectDir(id, false);
      const mediaDir = await dir.getDirectoryHandle('media');
      const handle = await mediaDir.getFileHandle(filename);
      return await handle.getFile();
    } catch (e) {
      return null;
    }
  }

  async function deleteProjectDir(id) {
    try {
      const work = await getWorkRoot(false);
      await work.removeEntry(id, { recursive: true });
    } catch (e) { /* nothing to delete */ }
  }

  /* --------------------------------------------------------------------------
   * The library index — library.json at the OPFS root. Reads are lock-free
   * (a torn read is impossible: createWritable swaps atomically on close);
   * writes are read-modify-write and serialize under the origin-global
   * LIBRARY_LOCK so two tabs editing different projects can't lose each
   * other's index updates. Every change notifies this tab's panel directly
   * and other tabs over a BroadcastChannel.
   * ------------------------------------------------------------------------ */

  async function readLibrary() {
    try {
      const root = await navigator.storage.getDirectory();
      const text = await readTextFrom(root, LIBRARY_FILE);
      const lib = text !== null ? JSON.parse(text) : null;
      if (lib === null || typeof lib !== 'object' || !Array.isArray(lib.projects)) {
        return { projects: [] };
      }
      return lib;
    } catch (e) {
      return { projects: [] };
    }
  }

  async function updateLibrary(mutate) {
    const run = async () => {
      const lib = await readLibrary();
      mutate(lib);
      const root = await navigator.storage.getDirectory();
      await writeFileTo(root, LIBRARY_FILE, JSON.stringify(lib));
      return lib;
    };
    let lib;
    if ('locks' in navigator) {
      lib = await navigator.locks.request(LIBRARY_LOCK, run);
    } else {
      lib = await run();
    }
    notifyLibraryChanged(false);
    return lib;
  }

  // The panel (hyperaudio-library.js) re-renders on this event; the channel
  // keeps a second tab's panel honest when this one writes the index.
  const libraryChannel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('hyperaudio:library') : null;
  function notifyLibraryChanged(fromRemote) {
    document.dispatchEvent(new CustomEvent('hyperaudioLibraryChanged'));
    if (fromRemote !== true && libraryChannel !== null) {
      libraryChannel.postMessage('changed');
    }
  }
  if (libraryChannel !== null) {
    libraryChannel.onmessage = () => notifyLibraryChanged(true);
  }

  // Per-project dirty (#456): the current project's index entry decides; a
  // tab without the project's lock falls back to its own session flag (its
  // edits never reach the working copy, so the index can't speak for it).
  async function isDirty() {
    if (!session.active) return false;
    if (!opfsAvailable || session.projectId === null || !hasProjectLock) return sessionEdited;
    const lib = await readLibrary();
    const entry = lib.projects.find((p) => p.id === session.projectId);
    return entry !== undefined ? isEntryDirty(entry) : sessionEdited;
  }

  /* ==========================================================================
   * 4. BRIDGE — the only layer that touches the editor's DOM
   * ======================================================================== */

  // Everything the module knows about the open project. Hydrated on new
  // transcript (hyperaudioInit), on open, on boot restore, and on a library
  // switch (#456).
  const session = {
    active: false,
    projectId: null,    // work/<projectId>/ this session writes to (#456); null = nowhere (demo, or deleted-but-on-screen)
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
  // Snapshot writes serialize on a promise chain (#448: parallel writes could
  // interleave files from different states); calls landing while one is
  // running or queued coalesce into ONE queued follow-up, which re-gathers —
  // so the last write always holds the latest state.
  let snapshotChain = Promise.resolve();
  let snapshotQueued = false;
  let autosavePending = false; // an edit is debouncing toward a snapshot write
  // Whether THIS tab owns the CURRENT project's working copy (#450 made
  // per-project by #456). Browsers without Web Locks (pre-15.4 Safari) assume
  // single-tab ownership — the pre-#450 status quo, no worse.
  let hasProjectLock = false;
  let projectLockRelease = null; // resolving this releases the held lock
  let projectLockQueue = null;   // AbortController for the queued promotion request
  let autosaveTimer = null;

  function nowIso() {
    return new Date().toISOString();
  }

  // The transcript's markup for the writer. Reads the live element directly
  // (NOT getTranscriptData(), whose blanket class strip destroys the speaker
  // class); in caption mode the transcript element only exists inside
  // editor-core's transcriptCache clone — read it from there.
  function getEditorHtml() {
    const el = document.querySelector('#hypertranscript');
    if (el !== null) return sanitizeTranscriptClasses(el.innerHTML);
    if (typeof transcriptCache !== 'undefined' && transcriptCache !== null) {
      const cached = transcriptCache.querySelector('#hypertranscript');
      if (cached !== null) return sanitizeTranscriptClasses(cached.innerHTML);
    }
    return typeof getTranscriptData === 'function' ? getTranscriptData() : '';
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

  // The info modal's Transcription section is project-bound (#456): rebuilt
  // here from the loaded project's STORED provenance whenever a project takes
  // the editor (apply below, import reset in onNewTranscript). A live engine
  // run still overwrites it with its richer rows (device, time taken) via
  // editor-core's setTranscriptionInfo — those extras aren't persisted, so a
  // reload shows this stored subset. DOM-built: provenance is file data,
  // never innerHTML (spec § 10.5).
  function renderTranscriptionInfo(provenance, language) {
    const container = document.getElementById('transcription-info');
    if (container === null) return;
    const rows = [];
    if (provenance && provenance.engine) rows.push(['Service', String(provenance.engine)]);
    if (provenance && provenance.model) rows.push(['Model', String(provenance.model)]);
    if (language) rows.push(['Language', String(language)]);
    if (provenance && provenance.transcribedAt) {
      const at = new Date(provenance.transcribedAt);
      if (!Number.isNaN(at.getTime())) rows.push(['Transcribed', at.toLocaleString()]);
    }
    container.textContent = '';
    if (rows.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'No transcription details recorded for this project.';
      container.appendChild(p);
      return;
    }
    rows.forEach(([label, value]) => {
      const p = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = label + ':';
      p.appendChild(strong);
      p.appendChild(document.createTextNode(' ' + value));
      container.appendChild(p);
    });
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
      renderTranscriptionInfo(loaded.recovered ? null : loaded.project.provenance,
        texts !== null ? (texts.language || '') : '');

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

  // Gather the live document and write it as ONE state file (draft.json or
  // saved.json). One atomic-enough artifact (#448): json + html + captions in
  // a single file, so a crash can never leave a mixed-generation multi-file
  // state. Absent captions are an explicit null — unambiguous. The origin and
  // media stay as separate immutable files. gather() and the projectId
  // capture are synchronous, so the write is of ONE document to ITS OWN
  // directory even if a switch lands mid-write.
  async function writeStateFile(projectId, filename) {
    const state = gather();
    const dir = await getProjectDir(projectId, true);
    const vtt = getCaptionsVtt();
    await writeFileTo(dir, filename, JSON.stringify({
      json: serializeProjectJson(buildProjectJson(state)),
      html: state.html,
      captionsVtt: vtt !== '' ? vtt : null,
    }));
    return state;
  }

  async function writeDraftNow() {
    if (!opfsAvailable || !session.active || !hasProjectLock || session.projectId === null) return;
    autosavePending = false;
    const projectId = session.projectId;
    try {
      const state = await writeStateFile(projectId, DRAFT_FILE);
      await touchLibraryEntry(projectId, state, { draft: true });
    } catch (e) {
      console.warn('hyperaudio-save: draft autosave failed', e);
    }
  }

  function writeDraft() {
    if (snapshotQueued) return snapshotChain;
    snapshotQueued = true;
    snapshotChain = snapshotChain.then(() => {
      snapshotQueued = false;
      return writeDraftNow();
    });
    return snapshotChain;
  }

  // Every state write refreshes the project's index entry — name (the title
  // Save uses), order timestamp, the dirty timestamps, media meta and the
  // hover-preview texts, so the panel renders from the index alone.
  async function touchLibraryEntry(id, state, stamps) {
    const now = Date.now();
    await updateLibrary((lib) => {
      let entry = lib.projects.find((p) => p.id === id);
      if (entry === undefined) {
        entry = {
          id,
          starred: false,
          createdAt: Date.parse(state.created) || now,
          lastDraftAt: 0,
          lastSavedAt: 0,
        };
        lib.projects.push(entry);
      }
      entry.name = state.texts.title;
      entry.modifiedAt = now;
      if (stamps && stamps.draft === true) entry.lastDraftAt = now;
      if (stamps && stamps.saved === true) {
        entry.lastSavedAt = now;
        entry.lastDraftAt = 0; // the draft died with the save
      }
      entry.media = {
        kind: state.media.kind,
        filename: state.media.filename || '',
        durationSeconds: state.media.durationSeconds || 0,
      };
      entry.summary = state.texts.summary || '';
      entry.topics = state.texts.topics || [];
    });
  }

  // Land the outgoing project's pending draft in its own directory before the
  // editor DOM changes hands (#456: switching loses nothing — the draft keeps
  // the edits, the dirty state stays honest). Await-ing the chain also lets
  // an in-flight write finish — its state was gathered before the call, so it
  // is still the outgoing document's.
  async function flushPendingDraft() {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    if (autosavePending) {
      await writeDraft();
    } else {
      await snapshotChain;
    }
  }

  // Manual Save (⌘S / the navbar button), Glider-matched: commit the live
  // document to saved.json SILENTLY — never a download — and retire the
  // draft. A future format revision records each manual save as a version.
  // In the native wrapper the bridge receives the built container instead
  // (#449: one save path for web and native); without OPFS the explicit
  // export download is the only durable copy, so Save falls back to it.
  async function saveProject() {
    if (saveInFlight) return false;
    saveInFlight = true;
    try {
      const bridge = window.hyperaudioProjectBridge;
      if (bridge && typeof bridge.save === 'function') {
        return await exportProject({ asSave: true }); // the bridge intercepts the built container
      }
      if (!opfsAvailable) {
        return await exportProject({ asSave: true }); // no OPFS: the download IS the save
      }
      if (!session.active || session.projectId === null) {
        await projectAlert('There is no project to save yet — transcribe or import something first.');
        return false;
      }
      const identityAtStart = identityGeneration;
      const editAtGather = editGeneration;
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
      autosavePending = false;
      const projectId = session.projectId;
      // ride the state-write chain so a draft write can't interleave and
      // resurrect the draft after the save deletes it
      let ok = false;
      snapshotChain = snapshotChain.then(async () => {
        try {
          const state = await writeStateFile(projectId, SAVED_FILE);
          const dir = await getProjectDir(projectId, false);
          await dir.removeEntry(DRAFT_FILE).catch(() => {});
          await touchLibraryEntry(projectId, state, { saved: true });
          ok = true;
        } catch (e) {
          console.warn('hyperaudio-save: save failed', e);
        }
      });
      await snapshotChain;
      if (!ok) {
        await projectAlert('Saving the project failed. Your work is still in the editor and the autosaved draft.');
        return false;
      }
      // Mark clean only if this save still belongs to the current document
      // AND no edit landed while it was being written (#448).
      if (identityGeneration === identityAtStart && editGeneration === editAtGather) {
        sessionEdited = false;
        updateSaveIndicator();
      }
      return true;
    } finally {
      saveInFlight = false;
    }
  }

  function scheduleAutosave() {
    if (!session.active || suppressCapture) return;
    sessionEdited = true;
    editGeneration += 1;
    updateSaveIndicator();
    if (!opfsAvailable) return;
    autosavePending = true;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(writeDraft, 1500);
  }

  async function writeMediaOnce() {
    if (!opfsAvailable || session.mediaFile === null || !hasProjectLock || session.projectId === null) return;
    try {
      const dir = await getProjectDir(session.projectId, true);
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

  // The current session's origin as held in memory, written to the project
  // dir — used when a project is born and when a deleted-but-on-screen
  // document is restored as a new entry (#456).
  async function writeOriginToProjectDir() {
    if (!opfsAvailable || !hasProjectLock || session.projectId === null || session.originalJson === null) return;
    try {
      const dir = await getProjectDir(session.projectId, true);
      await writeFileTo(dir, ENTRY.original, session.originalJson);
    } catch (e) {
      console.warn('hyperaudio-save: origin write failed', e);
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
    await writeOriginToProjectDir();
  }

  // A NEW project begins whenever a transcription or import lands a fresh
  // transcript (they all fire hyperaudioInit). It gets its own id, directory
  // and lock (#456) — the previous project stays in the library untouched.
  // No flush of the outgoing project here: by the time hyperaudioInit fires
  // the editor DOM already holds the NEW transcript, so a late gather would
  // write the wrong document into the old directory. Any autosave already
  // in flight gathered before the swap and lands correctly.
  async function onNewTranscript() {
    if (suppressCapture) return;
    const transcriptEl = document.querySelector('#hypertranscript');
    if (transcriptEl === null || transcriptEl.querySelector('span[data-m]') === null) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    autosavePending = false;
    releaseProjectLock();
    session.active = true;
    session.projectId = opfsAvailable ? newProjectId() : null;
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
      // an import with no engine run: the modal must not keep showing a
      // previous project's transcription details
      renderTranscriptionInfo(null, '');
    }
    if (opfsAvailable && session.projectId !== null) {
      await acquireProjectLock(session.projectId); // fresh id: always granted
      await writeOriginOnce(htmlToJSON(getEditorHtml()));
      await resolveMediaFile();
      await writeMediaOnce();
      await writeDraft(); // a fresh transcription is an unsaved draft
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

  /*
   * Completely remove the existing caption <track> and insert a fresh, empty
   * one (relocated from the legacy storage module in #451; #356/#287 history:
   * a reused track kept the PREVIOUS media's cue painted across a swap).
   */
  function resetCaptionTrack(videoDomId = 'hyperplayer', vttId = 'hyperplayer-vtt') {
    const video = document.getElementById(videoDomId);
    if (video === null) {
      return null;
    }
    const old = document.getElementById(vttId);
    if (old !== null) {
      old.remove();
    }
    const track = document.createElement('track');
    track.id = vttId;
    track.label = 'preview';
    track.kind = 'subtitles';
    track.src = '';
    video.appendChild(track);
    return track;
  }
  // the caption-regenerate path in editor-core reaches this by global name
  // (typeof-guarded), as it did when the legacy module defined it
  window.resetCaptionTrack = resetCaptionTrack;

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

  // Export Project (.hyperaudio): build the container and download it — the
  // ONLY path that downloads. Saving is the silent OPFS commit (saveProject);
  // export is how a portable copy leaves the browser. asSave marks the two
  // fallback contexts where the container IS the save (native bridge, no
  // OPFS) so success clears the dirty state there — a plain export never
  // touches it.
  let exportInFlight = false;
  async function exportProject(opts) {
    if (exportInFlight) return false; // one container build at a time (#448)
    exportInFlight = true;
    try {
      return await exportProjectInner(!!(opts && opts.asSave));
    } finally {
      exportInFlight = false;
    }
  }

  async function exportProjectInner(asSave) {
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
    if (originalJson === null && opfsAvailable && session.projectId !== null) {
      try {
        originalJson = await readTextFrom(await getProjectDir(session.projectId, false), ENTRY.original);
      } catch (e) { /* no project dir yet */ }
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
    // Only the save-fallback contexts mark clean (and only if this container
    // still belongs to the current document and no edit landed while it was
    // built, #448) — a plain export is a copy, not a save.
    if (asSave && identityGeneration === identityAtStart && editGeneration === editAtGather) {
      sessionEdited = false;
      updateSaveIndicator();
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

    // No discard dialog (#456): the outgoing project's pending draft flushes
    // to its own directory and stays in the library — opening loses nothing.
    // The dialog existed only because there was one work slot.
    await flushPendingDraft();

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

      // Hydrate the session and seed a NEW project directory so the autosave
      // continues from here. Every open makes a fresh library entry (#456) —
      // identity is OPFS-native, so re-opening the same file twice simply
      // creates a second entry.
      releaseProjectLock();
      session.active = true;
      session.projectId = opfsAvailable ? newProjectId() : null;
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

      if (opfsAvailable && session.projectId !== null) {
        await acquireProjectLock(session.projectId); // fresh id: always granted
        const dir = await getProjectDir(session.projectId, true);
        if (loaded.originalText !== null) await writeFileTo(dir, ENTRY.original, loaded.originalText);
        await writeMediaOnce();
      }
    } finally {
      suppressCapture = false;
    }
    // The opened file IS the saved state: seed saved.json, no draft — the
    // fresh entry starts clean.
    if (opfsAvailable && session.projectId !== null) {
      const id = session.projectId;
      snapshotChain = snapshotChain.then(async () => {
        try {
          const state = await writeStateFile(id, SAVED_FILE);
          await touchLibraryEntry(id, state, { saved: true });
        } catch (e) {
          console.warn('hyperaudio-save: seeding the opened project failed', e);
        }
      });
      await snapshotChain;
    }

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

  /* ==========================================================================
   * Project switching, boot restore and the library operations (#456)
   * ======================================================================== */

  // Read a project's working state from its directory — the DRAFT when one
  // exists (the edits made since the last Save), else the saved state.
  // Returns {project, captionsVtt, mediaFile, originalText, fromDraft} or
  // null when both are missing/unreadable/invalid (the caller leaves the
  // editor untouched).
  async function readProjectFiles(id) {
    try {
      const dir = await getProjectDir(id, false);
      let fromDraft = true;
      let stateText = await readTextFrom(dir, DRAFT_FILE);
      if (stateText === null) {
        fromDraft = false;
        stateText = await readTextFrom(dir, SAVED_FILE);
      }
      if (stateText === null) return null;
      let jsonText = null;
      let captionsVtt = null;
      try {
        const snapshot = JSON.parse(stateText);
        jsonText = typeof snapshot.json === 'string' ? snapshot.json : null;
        captionsVtt = typeof snapshot.captionsVtt === 'string' ? snapshot.captionsVtt : null;
      } catch (e) {
        console.warn('hyperaudio-save: unreadable project state file', e);
        return null;
      }
      if (jsonText === null) return null;
      const project = JSON.parse(jsonText);
      const validation = validateProjectJson(project);
      if (!validation.ok) {
        console.warn('hyperaudio-save: working copy failed validation', validation.errors);
        return null;
      }
      const mediaFile = project.media.kind === 'original'
        ? await readMediaFileFromProject(id, project.media.filename) : null;
      const originalText = await readTextFrom(dir, ENTRY.original);
      return { project, captionsVtt, mediaFile, originalText, fromDraft };
    } catch (e) {
      return null; // directory gone or OPFS refused
    }
  }

  // Replay project files into the editor and hydrate the session — shared by
  // boot restore and panel switches. prepare → apply ordering (#448): callers
  // read the files BEFORE tearing anything down.
  function applyProjectFiles(id, files) {
    const project = files.project;
    apply({ recovered: false, project, captionsVtt: files.captionsVtt, mediaFile: files.mediaFile });
    session.active = true;
    session.projectId = id;
    identityGeneration += 1; // a different document owns the session now
    session.created = project.created || nowIso();
    session.provenance = project.provenance || null;
    session.language = (project.texts && project.texts.language) || '';
    session.mediaFile = files.mediaFile;
    session.mediaFileFromUrl = null;
    session.pendingReconcile = project.media.kind === 'link' ? project.media : null;
    session.hasOriginal = files.originalText !== null;
    session.originalJson = files.originalText;
    session.envelope = project; // §8.1: a save after restore must preserve unknown fields too
  }

  // Switching asks nothing and loses nothing (#456): flush the outgoing
  // project's pending draft to its own directory, hand the editor to the
  // incoming one (draft first — its unsaved edits come back, still dirty),
  // move the per-project lock. Returns false (editor untouched) when the
  // target can't be read.
  async function switchToProject(id) {
    if (!opfsAvailable) return false;
    if (id === session.projectId) return true;
    const files = await readProjectFiles(id);
    if (files === null) return false;
    await flushPendingDraft();
    releaseProjectLock();
    suppressCapture = true;
    try {
      applyProjectFiles(id, files);
    } finally {
      suppressCapture = false;
    }
    await acquireProjectLock(id);
    const lib = await readLibrary();
    const entry = lib.projects.find((p) => p.id === id);
    sessionEdited = entry !== undefined ? isEntryDirty(entry) : files.fromDraft;
    updateSaveIndicator();
    notifyLibraryChanged(false); // active-row highlight moves
    return true;
  }

  /* ---- Library operations the panel calls (#456) ---- */

  // Rewrite texts.title inside a stored state file (draft or saved) so a
  // later switch reads the new name back rather than resurrecting the old.
  async function rewriteStateTitle(dir, filename, name) {
    const text = await readTextFrom(dir, filename);
    if (text === null) return;
    const snapshot = JSON.parse(text);
    const project = JSON.parse(snapshot.json);
    project.texts = Object.assign({}, project.texts, { title: name });
    snapshot.json = serializeProjectJson(project);
    await writeFileTo(dir, filename, JSON.stringify(snapshot));
  }

  // Rename IS the project title Save uses, so it lands everywhere the title
  // lives: the index entry, both stored state files, and — for the current
  // project — the live session.
  async function renameProject(id, newName) {
    const name = String(newName === null || newName === undefined ? '' : newName).trim();
    if (name === '') return;
    try {
      const dir = await getProjectDir(id, false);
      await rewriteStateTitle(dir, DRAFT_FILE, name);
      await rewriteStateTitle(dir, SAVED_FILE, name);
    } catch (e) {
      console.warn('hyperaudio-save: rename state rewrite failed', e);
    }
    if (id === session.projectId) {
      session.title = name;
      const titleField = document.querySelector('#project-title');
      if (titleField !== null) titleField.value = name;
    }
    await updateLibrary((lib) => {
      const entry = lib.projects.find((p) => p.id === id);
      if (entry !== undefined) entry.name = name;
    });
  }

  async function setProjectStarred(id, starred) {
    await updateLibrary((lib) => {
      const entry = lib.projects.find((p) => p.id === id);
      if (entry !== undefined) entry.starred = starred === true;
    });
  }

  // Duplicate: a new id sharing nothing — both state files, origin and media
  // are copied byte-for-byte. The copy is never the current project and
  // mirrors the source's dirty state (same draft/saved stamps).
  async function duplicateProject(id) {
    const srcLib = await readLibrary();
    const srcEntry = srcLib.projects.find((p) => p.id === id);
    if (srcEntry === undefined) return null;
    const newId = newProjectId();
    const copyName = (srcEntry.name || 'project') + ' copy';
    try {
      const src = await getProjectDir(id, false);
      const dst = await getProjectDir(newId, true);
      for (const name of [DRAFT_FILE, SAVED_FILE, ENTRY.original]) {
        const text = await readTextFrom(src, name);
        if (text !== null) await writeFileTo(dst, name, text);
      }
      try {
        const srcMedia = await src.getDirectoryHandle('media');
        const dstMedia = await dst.getDirectoryHandle('media', { create: true });
        for await (const [name, handle] of srcMedia.entries()) {
          if (handle.kind === 'file') await writeFileTo(dstMedia, name, await handle.getFile());
        }
      } catch (e) { /* no media dir */ }
      // the copy carries its own title so a later switch doesn't resurrect the old one
      await rewriteStateTitle(dst, DRAFT_FILE, copyName);
      await rewriteStateTitle(dst, SAVED_FILE, copyName);
    } catch (e) {
      console.warn('hyperaudio-save: duplicate failed', e);
      await deleteProjectDir(newId);
      return null;
    }
    const now = Date.now();
    await updateLibrary((lib) => {
      lib.projects.push(Object.assign({}, srcEntry, {
        id: newId,
        name: copyName,
        starred: false,
        createdAt: now,
        modifiedAt: now,
      }));
    });
    return newId;
  }

  // Delete removes the directory and the index entry. Deleting the CURRENT
  // project leaves the document on screen (the only undo there is) but
  // nothing owns it anymore — autosave stops until the panel's Restore
  // re-homes it as a new entry.
  async function deleteProject(id) {
    const wasCurrent = id === session.projectId;
    if (wasCurrent) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
      autosavePending = false;
      await snapshotChain; // let an in-flight write finish before the dir goes
      releaseProjectLock();
      session.projectId = null;
    }
    await deleteProjectDir(id);
    await updateLibrary((lib) => {
      lib.projects = lib.projects.filter((p) => p.id !== id);
    });
    return wasCurrent;
  }

  // Undo for deleting the current project: re-home the on-screen document —
  // still fully held by the session — under a fresh id.
  async function restoreCurrentAsNewProject(starred) {
    if (!opfsAvailable || !session.active || session.projectId !== null) return null;
    session.projectId = newProjectId();
    const id = session.projectId;
    await acquireProjectLock(id);
    await writeOriginToProjectDir();
    await writeMediaOnce();
    await writeDraft(); // re-homed work is an unsaved draft until Saved
    if (starred === true) await setProjectStarred(id, true);
    return id;
  }

  /* ---- Boot (#456): migrate any pre-#456 single-slot working copy, then
     restore the most recently edited project — the index IS the boot hint.
     The single-slot layout (work/snapshot.json + root app-state.json) never
     shipped in a release, so this migration only preserves dev working
     copies; pre-#448 multi-file layouts are older still and are left alone. */

  async function migrateSingleSlotWork() {
    try {
      const work = await getWorkRoot(false);
      const snapshotText = await readTextFrom(work, 'snapshot.json');
      if (snapshotText === null) return;
      const snapshot = JSON.parse(snapshotText);
      const project = JSON.parse(snapshot.json);
      const id = newProjectId();
      const dir = await getProjectDir(id, true);
      // the old slot was autosave state that had (maybe) never been taken out
      // of the browser — land it as a DRAFT, dirty until a real Save
      await writeFileTo(dir, DRAFT_FILE, snapshotText);
      const originalText = await readTextFrom(work, ENTRY.original);
      if (originalText !== null) await writeFileTo(dir, ENTRY.original, originalText);
      try {
        const srcMedia = await work.getDirectoryHandle('media');
        const dstMedia = await dir.getDirectoryHandle('media', { create: true });
        for await (const [name, handle] of srcMedia.entries()) {
          if (handle.kind === 'file') await writeFileTo(dstMedia, name, await handle.getFile());
        }
      } catch (e) { /* no media */ }
      let appState = {};
      try {
        const root = await navigator.storage.getDirectory();
        const text = await readTextFrom(root, APP_STATE_FILE);
        if (text !== null) appState = JSON.parse(text);
      } catch (e) { /* defaults below */ }
      const now = Date.now();
      await updateLibrary((lib) => {
        lib.projects.push({
          id,
          name: (project.texts && project.texts.title) || 'project',
          starred: false,
          createdAt: Date.parse(project.created) || now,
          modifiedAt: appState.lastWorkWriteAt || now,
          lastDraftAt: appState.lastWorkWriteAt || now,
          lastSavedAt: 0,
          media: {
            kind: project.media.kind,
            filename: project.media.filename || '',
            durationSeconds: project.media.durationSeconds || 0,
          },
          summary: (project.texts && project.texts.summary) || '',
          topics: (project.texts && project.texts.topics) || [],
        });
      });
      // the old slot is spent — remove it so this runs exactly once
      await work.removeEntry('snapshot.json').catch(() => {});
      await work.removeEntry(ENTRY.original).catch(() => {});
      await work.removeEntry('media', { recursive: true }).catch(() => {});
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(APP_STATE_FILE).catch(() => {});
      } catch (e) { /* fine */ }
      try { localStorage.removeItem('hyperaudioWorkPresent'); } catch (e) { /* retired hint */ }
    } catch (e) { /* no single-slot layout (the usual case) */ }
  }

  async function bootLibrary() {
    if (!opfsAvailable) {
      notifyLibraryChanged(false);
      return;
    }
    // The library is the only home of unexported work now — ask the browser
    // not to evict it under storage pressure. Best-effort; a denial changes
    // nothing about how we behave.
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } catch (e) { /* best-effort */ }
    try {
      await migrateSingleSlotWork();
      const lib = await readLibrary();
      // Most recently edited first; a corrupt head entry falls through to the
      // next rather than abandoning the boot (the demo stays for none).
      for (const entry of sortLibraryEntries(lib.projects)) {
        if (await switchToProject(entry.id)) break;
      }
    } catch (e) {
      console.warn('hyperaudio-save: boot restore failed, leaving demo', e);
    }
    notifyLibraryChanged(false);
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
    // The navbar Save button covers saving (#449, a silent OPFS commit since
    // #456), so the menu carries no Save item; opening a project lives with
    // the other imports, and Export Project is the explicit way to take a
    // portable .hyperaudio out of the browser — the only save-ish download.
    const importList = document.querySelector('#file-exportimport-submenu ul');
    if (importList !== null) {
      importList.insertAdjacentHTML('afterbegin',
        '<li><a id="project-open-hyperaudio">Import Project (.hyperaudio)</a></li>'
        + '<li><a id="project-export-hyperaudio">Export Project (.hyperaudio)</a></li>');
    } else {
      dropdown.insertAdjacentHTML('beforeend',
        '<li><a id="project-open-hyperaudio">Import Project (.hyperaudio)</a></li>'
        + '<li><a id="project-export-hyperaudio">Export Project (.hyperaudio)</a></li>');
    }
    document.querySelector('#project-export-hyperaudio').addEventListener('click', () => {
      exportProject().catch((e) => projectAlert('Exporting the project failed: ' + e.message));
    });

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
        saveProject().catch((e) => projectAlert('Saving the project failed: ' + e.message));
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
        saveProject().catch((e) => projectAlert('Saving the project failed: ' + e.message));
      }
    }, true);

    // The quit guard (#449), narrowed by #456: the per-project draft survives
    // closes and reloads, so leaving with unsaved changes loses NOTHING and
    // warning would be a lie. The one true loss case left is a document whose
    // library entry was deleted and lives only on screen — guard that.
    window.addEventListener('beforeunload', (event) => {
      if (session.active && sessionEdited && (session.projectId === null || !opfsAvailable)) {
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

  function showTabGuardBanner() {
    const anchor = document.getElementById('side-notices');
    if (anchor === null) return;
    if (document.getElementById('tab-guard-banner') !== null) return;
    const el = document.createElement('div');
    el.id = 'tab-guard-banner';
    el.setAttribute('role', 'status');
    el.textContent = 'This project is open in another tab — autosave and crash recovery are active there. You can still edit and save here, or switch to a different project.';
    anchor.appendChild(el);
  }

  function hideTabGuardBanner() {
    const el = document.getElementById('tab-guard-banner');
    if (el !== null) el.remove();
  }

  // Release the current project's working-copy lock (switching away, new
  // project, delete). Also abandons a queued promotion request — this tab is
  // no longer interested in that project.
  function releaseProjectLock() {
    if (projectLockQueue !== null) {
      projectLockQueue.abort();
      projectLockQueue = null;
    }
    if (projectLockRelease !== null) {
      projectLockRelease();
      projectLockRelease = null;
    }
    hasProjectLock = false;
    hideTabGuardBanner();
  }

  // Acquire a project's working-copy lock (#450, per-project since #456).
  // First tab wins; a tab finding the project locked shows the banner, keeps
  // FULL editing without the slot, and QUEUES — when the owner closes,
  // crashes or switches away, the waiting tab is promoted: banner drops,
  // captures enable from here on. No re-read on promotion — replacing a
  // mid-session document would be worse than the recovery it offers.
  function acquireProjectLock(id) {
    if (!('locks' in navigator)) {
      hasProjectLock = true; // no Web Locks (pre-15.4 Safari): single-tab assumption
      return Promise.resolve(true);
    }
    const lockName = PROJECT_LOCK_PREFIX + id;
    return new Promise((resolve) => {
      navigator.locks.request(lockName, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(false);
          return null;
        }
        hasProjectLock = true;
        resolve(true);
        return new Promise((release) => { projectLockRelease = release; });
      }).catch((e) => {
        console.warn('hyperaudio-save: project lock unavailable, assuming single tab', e);
        if (projectLockQueue !== null) { projectLockQueue.abort(); projectLockQueue = null; }
        hasProjectLock = true;
        resolve(true);
      });
    }).then((granted) => {
      if (granted) return true;
      showTabGuardBanner();
      projectLockQueue = new AbortController();
      navigator.locks.request(lockName, { signal: projectLockQueue.signal }, () => {
        projectLockQueue = null;
        if (session.projectId !== id) return null; // switched away as the grant raced the abort
        hasProjectLock = true;
        hideTabGuardBanner();
        return new Promise((release) => { projectLockRelease = release; });
      }).catch(() => { /* aborted: switched away before promotion */ });
      return false;
    });
  }

  function boot() {
    injectUi();
    wireCapture();
    bootLibrary();
  }

  // (The one-time legacy-storage notice from #451 was removed in 1.0.1 —
  // its wording predated the silent-save model, and the v0.9.1 retrieval
  // path is documented in the release notes. Old localStorage/IndexedDB
  // transcripts remain untouched on the device.)

  // Expose a small public API for other modules / the console.
  window.HyperaudioSave = {
    saveProject,     // silent OPFS commit (⌘S / the navbar button)
    exportProject,   // build + download a portable .hyperaudio
    // export naming and any future UI read the title through here
    getProjectTitle: () => session.title || (session.mediaFile !== null ? session.mediaFile.name : '') || '',
    // the document exports (#467) read the transcript through here: the same
    // speaker-preserving, caption-mode-aware gather the save path uses
    getTranscriptJson: () => htmlToJSON(getEditorHtml()),
    loadJSZip, // shared vendored-zip loader (the .docx export packages with it)
    openFromFile,
    autosaveNow: writeDraft,
    isDirty,
    opfsAvailable,
    // The project library (#456) — everything the side panel
    // (hyperaudio-library.js) needs; re-renders ride the
    // 'hyperaudioLibraryChanged' document event.
    library: {
      list: async () => sortLibraryEntries((await readLibrary()).projects),
      currentId: () => session.projectId,
      ownsCurrent: () => hasProjectLock,
      isEntryDirty,
      open: switchToProject,
      rename: renameProject,
      setStarred: setProjectStarred,
      duplicate: duplicateProject,
      remove: deleteProject,
      restoreDeleted: restoreCurrentAsNewProject,
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

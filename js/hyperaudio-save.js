/*
 * ============================================================================
 * .hyperaudio PROJECT SAVE — format, container, OPFS working copy, UI
 * ============================================================================
 *
 * @version 1.3.3 — last changed in release 1.3.3
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
  const FORMAT_VERSION = '1.3'; // 1.3: optional provenance.seconds/device (spec § 3.5); 1.2: kind "none", envelope preservation, pinned path/caps (spec § 8)
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

  // Embedder link schemes (#449's bridge, extended to media): a native
  // wrapper that serves media over its own URL scheme declares those schemes
  // here, and kind-"link" media accepts them wherever http(s) is accepted.
  // Embedder-scheme links are the embedder's responsibility: they are never
  // cached into the OPFS working copy (see exportProjectInner), so the
  // project stays kind "link" and the media bytes live only on the native
  // side — the embedder owns that URL's stability across renames, moves and
  // relaunches (spec § 7.2).
  function embedderLinkSchemes() {
    // Reached from the pure layer (validateProjectJson) — globalThis, not
    // window, so the node context (module.exports of `pure`) stays clean.
    const declared = globalThis.hyperaudioLinkSchemes;
    return Array.isArray(declared) ? declared : [];
  }
  function isEmbedderLinkUrl(src) {
    return typeof src === 'string' && embedderLinkSchemes().some((s) => src.startsWith(s));
  }
  function isLinkUrl(src) {
    return typeof src === 'string' && (/^https?:/i.test(src) || isEmbedderLinkUrl(src));
  }

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
      if (!isLinkUrl(media.url)) { // http(s) or a declared embedder scheme
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

  // The >= 1 paragraph normaliser (#492) lives in html-json-converter.js: a
  // plain global in the browser (it loads first), a require in the node
  // pure-layer tests — buildProjectJson is exported to those, so the invariant
  // has to hold on both sides or "writers emit at least one paragraph" is only
  // half true. Resolved once; null only if the converter is missing entirely,
  // and every caller below falls back to what it did before.
  const paragraphNormalizer = (function () {
    if (typeof normalizeTranscriptParagraphs === 'function') return normalizeTranscriptParagraphs;
    if (typeof require === 'function') {
      try {
        return require('./html-json-converter.js').normalizeTranscriptParagraphs || null;
      } catch (e) {
        return null;
      }
    }
    return null;
  })();

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
      // Writers emit at least one paragraph (§ 3.6, #492). One line covers
      // every path — the silent save, Export Project, the flattened export —
      // because they all assemble their JSON through here.
      transcript: (state.transcript !== null && state.transcript !== undefined
        && paragraphNormalizer !== null)
        ? paragraphNormalizer(state.transcript)
        : state.transcript,
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

  // Boot restores the project you were last LOOKING AT, which is not the same
  // as the last one written. modifiedAt is stamped by writes, so simply
  // opening a project to read it left it invisible to the boot order — and
  // switching away from A to B flushes A's pending draft, stamping A as the
  // newest, so a reload landed back on the project you had just left.
  // lastActiveAt is stamped when a project BECOMES current. Entries written
  // before this field fall back to modifiedAt, so an existing library keeps
  // its previous ordering rather than jumping to the bottom.
  function sortByLastActive(entries) {
    const key = (e) => e.lastActiveAt || e.modifiedAt || e.createdAt || 0;
    return entries.slice().sort((a, b) => key(b) - key(a));
  }

  // The deterministic per-project "dirty" rule (#456, Glider-matched): a
  // draft has been written since the last manual Save. A never-saved project
  // (fresh transcription) is dirty; an opened .hyperaudio starts clean (the
  // file IS the saved state).
  // Best-effort: a project the library has no entry for yet (a birth, before
  // its first write) gets its stamp when that write creates the entry.
  function markProjectActive(id) {
    if (!opfsAvailable || id === null) return;
    const now = Date.now();
    updateLibrary((lib) => {
      const entry = lib.projects.find((p) => p.id === id);
      if (entry !== undefined) entry.lastActiveAt = now;
    }).catch((e) => console.warn('hyperaudio-save: marking the project active failed', e));
  }

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
  function zipProject(files, JSZipImpl, outType, onUpdate) {
    const zip = new JSZipImpl();
    zip.file(ENTRY.mimetype, CONTAINER_MIMETYPE, { compression: 'STORE' });
    zip.file(ENTRY.json, files.json);
    if (files.html) zip.file(ENTRY.html, files.html);
    if (files.originalJson) zip.file(ENTRY.original, files.originalJson);
    if (files.captionsVtt) zip.file(ENTRY.captions, files.captionsVtt);
    if (files.media) {
      zip.file(MEDIA_DIR + sanitizeMediaFilename(files.media.name), files.media.data, { compression: 'STORE', binary: true });
    }
    // onUpdate is JSZip's own progress callback (second argument to
    // generateAsync) — optional so the node pure-layer tests call this
    // unchanged. Packing the media dominates the wait, so this is the only
    // step that can report a real percentage rather than a spinner (#502).
    return zip.generateAsync({
      type: outType || 'uint8array',
      compression: 'DEFLATE',
      streamFiles: true,
    }, typeof onUpdate === 'function' ? onUpdate : undefined);
  }

  // Whitelist-read of a container (spec § 10.1): only entries with known names
  // are ever read; everything else is ignored. Returns {project, htmlText,
  // captionsVtt, originalText, mediaData, warnings} — or {recovered: true,
  // htmlText, ...} when hyperaudio.json is missing/unreadable but the HTML
  // compatibility copy can be used (spec § 4 recovery). Throws {code, message}
  // on rejection (version-major, media-kind, unreadable, entry-too-large).
  async function unzipProject(data, JSZipImpl, onMediaProgress) {
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
        // Extracting the media is the long pole on the way in, and the only
        // step that can report a real percentage (#503).
        mediaData = await mediaEntry.async('uint8array',
          typeof onMediaProgress === 'function' ? onMediaProgress : undefined);
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
    syncProjectsHint(lib);
    notifyLibraryChanged(false);
    return lib;
  }

  // Synchronous boot hint (#473): OPFS can only be probed async, so the next
  // page load needs a sync signal that a project will replace the demo —
  // the inline head script hides the transcript on it before first paint.
  // Maintained here at the single write choke point; re-synced at boot so a
  // cleared localStorage heals after one flash.
  function syncProjectsHint(lib) {
    try {
      if (lib.projects.length > 0) {
        localStorage.setItem('hyperaudioHasProjects', '1');
      } else {
        localStorage.removeItem('hyperaudioHasProjects');
      }
    } catch (e) { /* private mode */ }
  }

  // Reveal the transcript hidden by the inline anti-flash script (#473).
  // Called on EVERY bootLibrary exit — restored, empty library, or failed
  // restore falling back to the demo.
  function revealTranscript() {
    document.documentElement.classList.remove('ha-restoring');
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
  // True while onNewTranscript is birthing a project. The engines dispatch
  // hyperaudioGenerateCaptionsFromTranscript right after hyperaudioInit as
  // part of a transcription landing; counting that pass as an edit left the
  // Save button dirty after every transcription even though the birth commit
  // (which gathers AFTER the captions are generated) matches the screen.
  let birthInProgress = false;
  // Lifecycle guards (#448): generations decide whether an async completion
  // may still be applied; in-flight flags serialize container/snapshot work.
  let editGeneration = 0;      // bumps on every edit signal
  let identityGeneration = 0;  // bumps when a DIFFERENT document commits
  let saveInFlight = false;

  // The last committed state's signature, so an undo that lands the editor
  // EXACTLY back on it can clear the dirty dot (the VS Code / NSDocument
  // semantics). sessionEdited alone can't express that — it's a monotone
  // edit-event flag with no notion of content equality. null = unknown (e.g.
  // a draft was restored, so the saved state isn't what's on screen); unknown
  // stays dirty, which is the previous behaviour.
  let savedSignature = null;
  // `modified` is stamped at every gather, so it would defeat any comparison.
  // Captions ride outside the project json: with sync OFF they are curated
  // content and part of the identity — undoing the transcript back while a
  // caption edit is pending is NOT clean. With sync ON the vtt is a pure
  // derivative of the transcript, regenerated on a deferred schedule (#517),
  // so comparing it would only race the regen queue — the transcript json
  // already carries the same information.
  function signatureFor(project, vtt) {
    project.modified = '';
    const syncOn = !!(project.options && project.options.captions
      && project.options.captions.updateFromTranscript !== false);
    return JSON.stringify(project) + '\u001f' + (syncOn ? '' : (vtt || ''));
  }
  function signatureOfParts(json, vtt) {
    return signatureFor(JSON.parse(json), vtt);
  }
  function stateSignature() {
    return signatureFor(buildProjectJson(gather()), getCaptionsVtt() || '');
  }

  // History and other same-document features must not infer identity from a
  // generic DOM refresh. Emit only beside identityGeneration commits.
  function signalDocumentIdentity(origin) {
    if (window.transcriptLifecycle
        && typeof window.transcriptLifecycle.signalIdentity === 'function') {
      window.transcriptLifecycle.signalIdentity(origin, {
        projectId: session.projectId,
      });
    }
  }
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

  // THE authoritative read of the transcript (#489): the live element's raw
  // innerHTML, or the caption-mode clone's, with only the class strip applied.
  // Nothing may transform it on the way in. htmlToJSON's selectors are
  // descendant-based, so a word span is found wherever editing has left it —
  // inside a wrapper the browser added, outside any <p> — and the JSON gets every
  // word. #486 briefly ran this through the canonical serializer instead, which
  // put the source of truth downstream of a presentation transform: two shapes
  // the serializer flattened stopped being cosmetic and started deleting words
  // from the container outright.
  //
  // NOT getTranscriptData(), whose blanket class strip destroys the speaker class.
  function getEditorTranscriptHtml() {
    const el = document.querySelector('#hypertranscript');
    if (el !== null) return sanitizeTranscriptClasses(el.innerHTML);
    if (typeof transcriptCache !== 'undefined' && transcriptCache !== null) {
      const cached = transcriptCache.querySelector('#hypertranscript');
      if (cached !== null) return sanitizeTranscriptClasses(cached.innerHTML);
    }
    return typeof getTranscriptData === 'function' ? getTranscriptData() : '';
  }

  // The transcript JSON — the container's source of truth. One parse, one place.
  function getEditorTranscriptJson() {
    return htmlToJSON(getEditorTranscriptHtml());
  }

  const wordSpanCount = (html) => {
    try {
      return new DOMParser().parseFromString(String(html), 'text/html')
        .querySelectorAll('span[data-m]:not(.speaker)').length;
    } catch (e) {
      return -1; // unknown; the invariant below treats that as "don't judge"
    }
  };

  // transcript.html is a PROJECTION of the JSON, not a second reading of the DOM
  // (§ 4 calls it the compatibility copy, generated from the same state in the
  // same save). jsonToHTML is the same writer the alignment path already uses, so
  // the two entries cannot disagree by construction — where two independent
  // derivations could, and § 4's anti-divergence rule would be a promise the code
  // had to keep rather than one it holds structurally.
  //
  // The invariant is checked rather than assumed: every word span in the DOM must
  // survive into the JSON, and every JSON word into the projection. On a mismatch
  // the raw source is written instead and the discrepancy logged — § 4's MAY/SHOULD
  // for exactly this case. A projection can hold nothing the JSON lost, so when the
  // parse or the projection is suspect, the unprojected markup is the only copy
  // left with every word in it. (§ 4 no longer claims this entry is an independent
  // witness in the normal case; that role went with the change, deliberately.)
  function projectTranscriptHtml(transcript, source) {
    const words = (transcript && transcript.words) || [];
    // no timed words yet — loader markup mid-transcription; pass it through as
    // before rather than projecting an empty article over it
    if (words.length === 0) return source;
    if (typeof jsonToHTML !== 'function') return source;

    const inDom = wordSpanCount(source);
    if (inDom >= 0 && inDom !== words.length) {
      console.warn('hyperaudio-save: transcript parse lost words —'
        + ` ${inDom} word spans in the editor, ${words.length} in the JSON.`
        + ' Writing the raw transcript markup so nothing is dropped from both.');
      return source;
    }

    const projected = jsonToHTML(transcript);
    const inProjection = wordSpanCount(projected);
    if (inProjection >= 0 && inProjection !== words.length) {
      console.warn('hyperaudio-save: transcript projection lost words —'
        + ` ${words.length} in the JSON, ${inProjection} in the generated HTML.`
        + ' Writing the raw transcript markup instead.');
      return source;
    }
    return projected;
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
    if (isLinkUrl(src)) { // http(s) or a declared embedder scheme
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
      // Name link media from its URL leaf — otherwise a link-kind birth
      // falls through gather()'s title chain (title field → session.title →
      // media.filename → 'project') and every URL-mode transcription is
      // christened "project".
      return { kind: 'link', path: null, url: src, filename: mediaDisplayName2(src) || '', mimeType: '', durationSeconds: duration, sizeBytes: 0 };
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
    if (!src || isLinkUrl(src)) return null;
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
    // One read of the DOM, parsed once; the HTML entry is projected from the
    // resulting JSON rather than read again (#489).
    const source = getEditorTranscriptHtml();
    const transcript = htmlToJSON(source);
    const html = projectTranscriptHtml(transcript, source);
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
    // >= 1 paragraph via the shared normaliser (#492) — the local
    // -Infinity/Infinity synthesis this replaces was a third answer to the
    // same question, and the three projections disagreed. The inline fallback
    // stays: readers MUST tolerate paragraph-less input, and this one runs
    // against file data.
    const paragraphs = (transcript.paragraphs && transcript.paragraphs.length > 0)
      ? transcript.paragraphs
      : (paragraphNormalizer !== null
        ? paragraphNormalizer(transcript).paragraphs
        : [{ start: -Infinity, end: Infinity, speaker: null }]);
    const article = document.createElement('article');
    const section = document.createElement('section');
    article.appendChild(section);

    // Assign EVERY word to exactly one paragraph (#488). The half-open range
    // filter this replaces (start >= pStart && start < pEnd) deleted words
    // silently: htmlToJSON derives a paragraph's end from its LAST word's end,
    // so a zero-duration final word (end == start == pEnd) failed its own
    // paragraph's range and never reached the DOM — and the next save then
    // wrote the transcript without it. Diarizer paragraph times that don't
    // exactly bracket word times stranded words the same way.
    //
    // Same rule jsonToHTML already applies (js/html-json-converter.js, #408):
    // a word belongs to the last paragraph that has started by the word's start
    // time; words before the first paragraph go to the first.
    const assignedWords = paragraphs.map(() => []);
    words.forEach((word) => {
      let idx = 0;
      let bestStart = -Infinity;
      paragraphs.forEach((paragraph, i) => {
        if (word.start >= paragraph.start && paragraph.start >= bestStart) {
          idx = i;
          bestStart = paragraph.start;
        }
      });
      assignedWords[idx].push(word);
    });

    paragraphs.forEach((paragraph, paragraphIndex) => {
      const p = document.createElement('p');
      const paragraphWords = assignedWords[paragraphIndex];
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
  // the editor (apply below, import reset in onNewTranscript). Since format
  // 1.3 the stored provenance carries the engine report's seconds/device too
  // (#457), so a reload shows the same rows as a live run — minus rows the
  // engine never reported. DOM-built: provenance is file data, never
  // innerHTML (spec § 10.5).
  function renderTranscriptionInfo(provenance, language) {
    const container = document.getElementById('transcription-info');
    if (container === null) return;
    const rows = [];
    if (provenance && provenance.engine) rows.push(['Service', String(provenance.engine)]);
    if (provenance && provenance.model) rows.push(['Model', String(provenance.model)]);
    if (language) rows.push(['Language', String(language)]);
    if (provenance && provenance.device) rows.push(['Processing', String(provenance.device)]);
    if (provenance && typeof provenance.seconds === 'number' && Number.isFinite(provenance.seconds)) {
      // same shape as editor-core's live setTranscriptionInfo formatting
      const minutes = Math.floor(provenance.seconds / 60);
      const seconds = Math.round(provenance.seconds % 60);
      rows.push(['Time taken', minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`]);
    }
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
      // If the transcript was being edited at switch time, the HOST keeps
      // focus across the content swap and the selection collapses to host
      // offset 0 — a stray caret rendered on a phantom line above the first
      // paragraph. Opening a project is not an edit: drop focus, and clear
      // the stale host-anchored selection too or a later programmatic focus
      // resurrects the caret at the same phantom spot. The caret appears
      // where the user next clicks.
      if (document.activeElement === transcriptEl) transcriptEl.blur();
      const staleSel = window.getSelection();
      if (staleSel !== null && staleSel.anchorNode !== null
          && (staleSel.anchorNode === transcriptEl || transcriptEl.contains(staleSel.anchorNode))) {
        staleSel.removeAllRanges();
      }

      // Media: original file via an object URL; a "link" descriptor plays the
      // remote URL directly (degraded is declared by the caller's messaging).
      const player = document.querySelector('#hyperplayer');
      if (loaded.mediaFile) {
        player.src = URL.createObjectURL(loaded.mediaFile);
      } else if (!loaded.recovered && loaded.project.media.kind === 'link' && loaded.project.media.url) {
        player.src = loaded.project.media.url;
      }

      // Captions through the one door: fresh track AND a paint flush (#356/#287).
      // Opening a project — Recents included — reuses the paused <video>, so the
      // previous document's cue pixels linger without the flush. This path had
      // the teardown but not the flush, which is how the bug came back on the
      // Recents route after the transcribe route was fixed.
      const captionsSrc = loaded.captionsVtt
        ? 'data:text/vtt,' + encodeURIComponent(loaded.captionsVtt)
        : '';
      const track = applyCaptionTrack(captionsSrc, {
        kind: loaded.captionsVtt ? 'captions' : 'subtitles',
        // no VTT: leave the fresh track disabled exactly as before and let the
        // regenerate event below build the captions (it flushes too)
        mode: loaded.captionsVtt ? 'showing' : 'disabled',
      });
      const options = loaded.recovered ? null : loaded.project.options;
      if (typeof updateCaptionsFromTranscript !== 'undefined') {
        updateCaptionsFromTranscript = options && options.captions
          ? options.captions.updateFromTranscript !== false : true;
      }
      if (loaded.captionsVtt && track !== null) {
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
    const json = serializeProjectJson(buildProjectJson(state));
    await writeFileTo(dir, filename, JSON.stringify({
      json,
      html: state.html,
      captionsVtt: vtt !== '' ? vtt : null,
    }));
    // Every commit funnels through here (save, project birth, open-seeding),
    // so this is the one place the clean-state signature is captured — from
    // the parts actually written, not a re-gather that later edits could skew.
    if (filename === SAVED_FILE) savedSignature = signatureOfParts(json, vtt);
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
          lastActiveAt: now, // a project being written IS the current one
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
      // The document's own timeline (last word's end): the glance duration
      // for projects with no media — text-only imports, the benchmark —
      // whose media.durationSeconds is honestly 0.
      const words = (state.transcript && state.transcript.words) || [];
      entry.docDurationSeconds = words.length ? words[words.length - 1].end : 0;
      entry.summary = state.texts.summary || '';
      entry.topics = state.texts.topics || [];
    });
  }

  // Every project birth — transcription, import, opened file, delete-undo
  // re-home — commits its initial state as saved.json and starts CLEAN: v0
  // is the material the project was born from (the immutable origin already
  // preserves the as-transcribed baseline at the format level). The dirty
  // dot means "edited since the last committed state", never "you haven't
  // performed a first Save".
  function commitInitialState(id) {
    snapshotChain = snapshotChain.then(async () => {
      try {
        const state = await writeStateFile(id, SAVED_FILE);
        await touchLibraryEntry(id, state, { saved: true });
      } catch (e) {
        console.warn('hyperaudio-save: committing the new project failed', e);
      }
    });
    return snapshotChain;
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
  function flushTranscriptMaintenanceBarrier(origin) {
    if (typeof window.hyperaudioFlushTranscriptMaintenance !== 'function') return;
    const state = typeof window.hyperaudioInspectTranscriptMaintenance === 'function'
      ? window.hyperaudioInspectTranscriptMaintenance() : null;
    if (state && !state.pendingGlobal && !state.local.dirty
        && !state.reconciliation.dirty) return;
    window.hyperaudioFlushTranscriptMaintenance(origin, {
      force: true,
      global: true,
    });
  }

  async function saveProject() {
    if (saveInFlight) return false;
    saveInFlight = true;
    try {
      flushTranscriptMaintenanceBarrier('sanitise-save');
      // With a bridge registered AND OPFS available, the bridge COMPOSES with
      // the silent commit instead of replacing it: the commit runs below and
      // the finished container is additionally handed to the bridge at the
      // end. The bridge-only short-circuit remains for OPFS-less contexts,
      // where the handed-over container IS the save. (#449 predates the
      // project library; as shipped, registering the bridge silently
      // disabled the library's own saved.json/draft semantics.)
      const bridge = window.hyperaudioProjectBridge;
      if (bridge && typeof bridge.save === 'function' && !opfsAvailable) {
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
      // The commit succeeded — now also hand the finished container to the
      // bridge (see the note above). Failures here are the bridge's to
      // report; the commit already stands.
      if (bridge && typeof bridge.save === 'function') {
        try {
          await exportProject({ asSave: true });
        } catch (e) {
          console.warn('hyperaudio-save: bridge save failed after commit', e);
        }
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
      // the origin is a written file too, so it carries the invariant (#492) —
      // this defaulted to [], one of the places paragraph-less JSON came from
      paragraphs: (paragraphNormalizer !== null
        ? paragraphNormalizer(transcript).paragraphs
        : transcript.paragraphs || []),
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
    // Raised synchronously inside the hyperaudioInit dispatch — i.e. BEFORE
    // the engine's follow-up caption event fires — and lowered once the birth
    // commit completes. User edits during the window still mark dirty through
    // the input/click listeners; only the app's own caption pass is exempt.
    birthInProgress = true;
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    autosavePending = false;
    releaseProjectLock();
    session.active = true;
    session.projectId = opfsAvailable ? newProjectId() : null;
    session.created = nowIso();
    session.hasOriginal = false;
    session.mediaFileFromUrl = null;
    // A birth with NO source in the player is a text-only document (a JSON/SRT
    // import, the benchmark's synthetic transcript) — a File captured for a
    // PREVIOUS project must not survive into it, or the new project's media
    // claims someone else's file. Engines always have a src (blob: or URL) set
    // before they dispatch hyperaudioInit, so this never touches their births.
    {
      const player = document.querySelector('#hyperplayer');
      if (player === null || !player.getAttribute('src')) session.mediaFile = null;
    }
    session.pendingReconcile = null;
    session.title = '';
    session.envelope = null; // a fresh document has no envelope to preserve
    // With OPFS the birth is committed below and the project starts CLEAN;
    // without it nothing persists, so the session stays marked edited and
    // the quit guard keeps protecting the on-screen work.
    sessionEdited = session.projectId === null;
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
    signalDocumentIdentity('transcription-or-import');
    try {
      if (opfsAvailable && session.projectId !== null) {
        await acquireProjectLock(session.projectId); // fresh id: always granted
        await writeOriginOnce(getEditorTranscriptJson());
        await resolveMediaFile();
        await writeMediaOnce();
        await commitInitialState(session.projectId); // v0: as transcribed/imported
        updateSaveIndicator();
      }
    } finally {
      birthInProgress = false;
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
      + '<div id="project-dialog-title" class="project-dialog-title" style="display:none"><span aria-hidden="true">⚠</span> <span id="project-dialog-title-text"></span></div>'
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
    // The warning dress (#506): amber left border + tinted title band,
    // reserved for state-divergence warnings — bold enough to register,
    // on the same modal chassis as everything else.
    const box = el.querySelector('.modal-box');
    box.classList.toggle('modal-warning', opts.warning === true);
    const title = el.querySelector('#project-dialog-title');
    title.style.display = opts.title ? '' : 'none';
    el.querySelector('#project-dialog-title-text').textContent = opts.title || '';
    const msg = el.querySelector('#project-dialog-message');
    msg.style.marginTop = opts.title ? '0' : '22px';
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
      // Dismissing an OK-alert acknowledges it. dismissResult overrides for
      // dialogs where the cancel button is a lasting choice ("don't tell me
      // again") that a shrugged-off ✕/Escape must NOT silently make.
      const dismissed = () => done(opts.dismissResult !== undefined
        ? opts.dismissResult : opts.cancel === false);
      const onClose = () => dismissed();
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          dismissed();
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
  // Part 2 of #356/#287, and the half that keeps getting lost. Replacing the
  // <track> drops the old cue DATA, but a PAUSED video does not re-composite its
  // native caption overlay, so the previous cue's PIXELS stay stranded on screen
  // — under the new captions, which is the "two sets of captions" report.
  //
  // Resetting the track and setting mode = 'showing' once is NOT enough: that is
  // exactly what the transcribe path already did when #356/#287 was still live,
  // and fcc323c had to add this explicit toggle on top of it. Only a deliberate
  // hidden -> showing transition, after the new src is in place, rebuilds the
  // overlay. Nothing to flush when the intended mode is 'hidden' (mp3/m4a).
  function flushCaptionPaint(videoDomId = 'hyperplayer') {
    const video = document.getElementById(videoDomId);
    const textTrack = video !== null && video.textTracks !== undefined
      ? video.textTracks[0] : undefined;
    if (textTrack === undefined) return;
    if (textTrack.mode === 'showing') {
      textTrack.mode = 'hidden';
      textTrack.mode = 'showing';
    }
  }

  // THE one door for a caption swap that comes with a NEW document (#356/#287):
  // project open, Recents switch, SRT/VTT import, transcribe/regenerate. It does
  // both halves — fresh <track> element, then the paint flush — so no caller has
  // to remember either, which is how this bug kept coming back one path at a
  // time. Every new caption writer should call this rather than assigning
  // #hyperplayer-vtt.src directly.
  //
  // NOT for the live-edit sanitise path: that re-runs on every keystroke and must
  // neither swap the element nor churn the caption paint.
  function applyCaptionTrack(vttSrc, opts) {
    const settings = opts || {};
    const track = resetCaptionTrack();
    if (track === null) return null;
    const src = (typeof vttSrc === 'string' && vttSrc !== '') ? vttSrc : '';
    if (src !== '') track.src = src;
    if (settings.kind !== undefined) track.kind = settings.kind;
    if (settings.label !== undefined) track.label = settings.label;
    if (settings.srcLang !== undefined) track.srcLang = settings.srcLang;
    // A fresh <track> element starts 'disabled', so the intended mode has to be
    // set explicitly or the captions simply never appear.
    const video = document.getElementById('hyperplayer');
    const textTrack = video !== null && video.textTracks !== undefined
      ? video.textTracks[0] : undefined;
    const mode = settings.mode !== undefined ? settings.mode : 'showing';
    if (textTrack !== undefined) textTrack.mode = mode;
    flushCaptionPaint();
    guardAgainstLateCaptionWrite(video, track, src, mode);
    return track;
  }

  // Part 3 of #356/#287, and the one that survived the first two fixes.
  //
  // The vendored caption.js applies its VTT on 'loadedmetadata' when the media
  // has not loaded yet — and the listener closes over THAT document's captions.
  // Nothing cancels it when the document changes, so a caption pass run while
  // the intro (remote, slow) was still loading stays pending, and fires when the
  // NEXT media's metadata arrives: the previous document's captions land on top
  // of the one just opened.
  //
  // ONE armed listener with a mutable target (#515): the original armed a
  // fresh one-shot listener per call, which was fine for the open path but
  // stacks listeners if a per-keystroke route arms it while metadata stays
  // pending — the sanitise pass fires every second while typing. Each call
  // now just updates the target; the single listener re-asserts the LATEST
  // intended swap after any straggler (at the target, listeners run in
  // registration order, and this one is necessarily registered later than a
  // pending stale one). Only armed while metadata is pending — once loaded, a
  // stale listener has already fired, so there is nothing to outlast.
  //
  // The real fix belongs upstream (capture the media identity at registration
  // and bail if it changed); this is the local defence until that lands.
  let lateWriteTarget = null; // { track, src, mode }
  let lateWriteVideo = null;  // the element the armed listener is bound to

  function guardAgainstLateCaptionWrite(video, track, src, mode) {
    if (video === null) return;
    if (video.readyState >= 1 /* HAVE_METADATA */) { lateWriteTarget = null; return; }
    lateWriteTarget = { track, src, mode };
    if (lateWriteVideo === video) return; // armed already; target updated above
    lateWriteVideo = video;
    video.addEventListener('loadedmetadata', function reassert() {
      video.removeEventListener('loadedmetadata', reassert);
      lateWriteVideo = null;
      const target = lateWriteTarget;
      lateWriteTarget = null;
      if (target === null) return;
      // Still OUR swap? resetCaptionTrack replaces the element, so a later
      // applyCaptionTrack — a newer document — leaves a different one in place
      // and this re-assert must stand down. A straggler from caption.js writes
      // .src on the existing element, so identity still holds there, which is
      // exactly the case worth correcting.
      const current = document.getElementById('hyperplayer-vtt');
      if (current === null || current !== target.track) return;
      let changed = false;
      if (target.src !== '' && current.getAttribute('src') !== target.src) {
        current.src = target.src;
        changed = true;
      }
      const tt = video.textTracks !== undefined ? video.textTracks[0] : undefined;
      if (tt !== undefined && tt.mode !== target.mode) {
        tt.mode = target.mode;
        changed = true;
      }
      if (changed) flushCaptionPaint();
    });
  }

  // The transcribe/regenerate routes write the track in editor-core's
  // generateCaptionsFromTranscript, outside applyCaptionTrack — before #515
  // they survived a stale caption.js straggler only because caption.js also
  // defers ITS write and registration order happened to put the right one
  // last. This zero-argument form lets that funnel arm the same guard the
  // open/import paths use: it reads whatever was just written and defends it.
  function guardCurrentCaptionWrite() {
    const video = document.getElementById('hyperplayer');
    const track = document.getElementById('hyperplayer-vtt');
    if (video === null || track === null) return;
    const tt = video.textTracks !== undefined ? video.textTracks[0] : undefined;
    guardAgainstLateCaptionWrite(video, track, track.getAttribute('src') || '',
      tt !== undefined ? tt.mode : 'showing');
  }
  window.guardCurrentCaptionWrite = guardCurrentCaptionWrite;

  // the caption-regenerate path in editor-core reaches these by global name
  // (typeof-guarded), as it did when the legacy module defined resetCaptionTrack
  window.resetCaptionTrack = resetCaptionTrack;
  window.flushCaptionPaint = flushCaptionPaint;
  window.applyCaptionTrack = applyCaptionTrack;

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

  // Flattened project export (#455): build a fresh .hyperaudio around a
  // RENDERED export — the render becomes the new project's original media
  // (relative to it nothing is "derived", spec § 1.1), the re-timed
  // struck-free transcript its transcript. Called by the media-export modal
  // with the artifacts it already produced; this module contributes what it
  // owns (texts, provenance, options, the container layers). Deliberate
  // differences from a Save/Export of the current project:
  //   - envelope: null — this is a NEW document, not a round-trip of the
  //     opened one, so no unknown-field preservation applies;
  //   - hasOriginal: false — the origin transcript no longer matches the
  //     rendered timeline, so transcript.original.json is not carried over;
  //   - gapRemoval disabled — the cuts are baked into the media; replaying
  //     them on the new timeline would cut twice.
  // parts: { html, captionsVtt, media: {name, data(Blob), mimeType,
  //          durationSeconds}, title }  →  Promise<Blob>
  async function buildFlattenedProjectBlob(parts) {
    const base = gather();
    const transcript = htmlToJSON(parts.html);
    const safeName = sanitizeMediaFilename(parts.media.name);
    const now = nowIso();
    const state = Object.assign({}, base, {
      envelope: null,
      created: now,
      modified: now,
      media: {
        kind: 'original',
        path: MEDIA_DIR + safeName,
        url: null,
        filename: safeName,
        mimeType: parts.media.mimeType || (parts.media.data && parts.media.data.type) || '',
        durationSeconds: parts.media.durationSeconds || 0,
        sizeBytes: parts.media.data.size,
      },
      options: Object.assign({}, base.options, {
        gapRemoval: Object.assign({}, base.options.gapRemoval, { enabled: false }),
      }),
      texts: Object.assign({}, base.texts,
        parts.title ? { title: String(parts.title) } : {}),
      hasOriginal: false,
      transcript,
      html: parts.html,
    });
    const project = buildProjectJson(state);
    const valid = validateProjectJson(project);
    if (!valid.ok) {
      throw new Error('The flattened project failed validation: '
        + valid.errors.map((e) => e.code).join(', '));
    }
    return zipProject({
      json: serializeProjectJson(project),
      html: parts.html,
      captionsVtt: parts.captionsVtt || '',
      media: { name: safeName, data: parts.media.data },
    }, await loadJSZip(), 'blob');
  }

  // Export Project (.hyperaudio): build the container and download it — the
  // ONLY path that downloads. Saving is the silent OPFS commit (saveProject);
  // export is how a portable copy leaves the browser. asSave marks the two
  // fallback contexts where the container IS the save (native bridge, no
  // OPFS) so success clears the dirty state there — a plain export never
  // touches it.
  let exportInFlight = false;
  async function exportProject(opts) {
    if (exportInFlight) {
      // Returning false silently (as this did) is the same dead end that makes
      // a user click again in the first place — the build is slow and, before
      // #502, invisible. Say what is happening instead.
      showProgress('Still building the project file…', 2000);
      return false;
    }
    exportInFlight = true;
    const token = beginProgress();
    try {
      flushTranscriptMaintenanceBarrier('sanitise-project-export');
      return await exportProjectInner(!!(opts && opts.asSave), token);
    } finally {
      exportInFlight = false;
      hideProgress(token);
    }
  }

  async function exportProjectInner(asSave, token) {
    const identityAtStart = identityGeneration;
    // Before the first await: the click is acknowledged even if resolving the
    // media out of OPFS takes a moment.
    showProgress('Preparing the project file…', 0, token);
    let mediaFile = await resolveMediaFile();
    const player = document.querySelector('#hyperplayer');
    // Media on an embedder scheme exports self-contained — the bytes are
    // fetched through the embedder's scheme handler for THIS archive only.
    // Deliberately no session.mediaFile / session.mediaFileFromUrl caching
    // and no writeMediaOnce(): the OPFS working copy must stay kind "link"
    // (the media's one durable copy lives on the embedder's side).
    const embedderSrc = player !== null && isEmbedderLinkUrl(player.src) ? player.src : null;
    const remoteSrc = player !== null && /^https?:/i.test(player.src) ? player.src : null;
    let saveAsLink = false;
    let embedderMedia = null;
    let deferEmbedToBridge = null;

    if (mediaFile === null && embedderSrc !== null) {
      const embedBridge = window.hyperaudioProjectBridge;
      if (embedBridge && typeof embedBridge.save === 'function') {
        // With a bridge registered, do NOT pull the media through the page —
        // a full-file fetch through the embedder's scheme handler contends
        // with the player's own streaming and starves playback right after a
        // save. The container is built link-kind with no media entry; the
        // bridge embeds the bytes natively (it has the file) and flips the
        // descriptor to "original" before the archive lands.
        deferEmbedToBridge = embedderSrc;
        saveAsLink = true; // container carries the link; the bridge upgrades it
      } else {
        showProgress('Reading the media…', 0, token);
        mediaFile = await fetchRemoteMediaFile(embedderSrc);
        embedderMedia = mediaFile;
      }
    }
    if (mediaFile === null && remoteSrc !== null) {
      if (session.mediaFile !== null && session.mediaFileFromUrl === remoteSrc) {
        mediaFile = session.mediaFile; // already embedded by a previous save of this project
      } else {
        try {
          // a full media download over the network — the one step that can
          // take longer than the packing, so it gets its own message
          showProgress('Downloading the media…', 0, token);
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
    // In-page fallback (no bridge): the gathered descriptor says "link"
    // (the session cache was never touched), but this archive carries the
    // bytes — so the CONTAINER's descriptor becomes a normal self-contained
    // "original". The working copy keeps gathering "link".
    if (embedderMedia !== null && state.media && state.media.kind === 'link') {
      const safeName = sanitizeMediaFilename(embedderMedia.name);
      state.media = {
        kind: 'original',
        path: MEDIA_DIR + safeName,
        url: null,
        filename: safeName,
        mimeType: embedderMedia.type || '',
        durationSeconds: state.media.durationSeconds,
        sizeBytes: embedderMedia.size,
      };
    }
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

    showProgress('Packaging the project file…', 0, token);
    const JSZipImpl = await loadJSZip();
    let lastPercent = -1;
    const blob = await zipProject({
      json: serializeProjectJson(buildProjectJson(state)),
      html: state.html,
      originalJson,
      captionsVtt: getCaptionsVtt() || null,
      media: mediaFile !== null ? { name: mediaFile.name, data: mediaFile } : null,
    }, JSZipImpl, 'blob', (meta) => {
      // JSZip fires this very frequently; only repaint on a whole percent
      const percent = Math.floor(meta.percent);
      if (percent === lastPercent) return;
      lastPercent = percent;
      showProgress('Packaging the project file… ' + percent + '%', 0, token);
    });

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
        // The third argument tells the bridge which media to embed natively
        // (see deferEmbedToBridge above). Bridges that don't understand it
        // simply ignore the extra argument.
        handled = (await bridge.save(blob, suggestedName,
          deferEmbedToBridge !== null ? { embedMediaFromUrl: deferEmbedToBridge } : undefined)) !== false;
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

  // One open at a time (#504). openFromFile is await-heavy — unzip, draft
  // flush, apply, OPFS seeding — and the file input called it directly, so a
  // second open starting mid-flight interleaved with the first at every await
  // point: two library entries, and session.projectId, the OPFS lock and the
  // media write left in an order neither call controlled. The export path has
  // refused concurrent runs since #448; this is the same guard for the way in.
  let openInFlight = false;

  async function openFromFile(file) {
    if (openInFlight) {
      showProgress('Still opening a project — one at a time.', 2000);
      return;
    }
    openInFlight = true;
    const token = beginProgress();
    try {
      return await openFromFileInner(file, token);
    } finally {
      openInFlight = false;
      hideProgress(token);
    }
  }

  async function openFromFileInner(file, token) {
    leaveTranscriptionView(); // #525: the busy styling must not follow us
    // Parse and validate BEFORE the replace-confirmation: asking permission
    // to replace the current project and THEN refusing the file meant the
    // user consented to a replacement that never happened (prepare → confirm
    // → apply, the #448 ordering).
    let loaded;
    try {
      // Before the first await: opening a real project reads the whole media
      // into memory twice (unzip, then the File wrapper) and seeds OPFS with
      // it, which is seconds of nothing on screen (#503).
      showProgress('Opening the project file…', 0, token);
      const JSZipImpl = await loadJSZip();
      let lastPercent = -1;
      loaded = await unzipProject(file, JSZipImpl, (meta) => {
        const percent = Math.floor(meta.percent);
        if (percent === lastPercent) return;
        lastPercent = percent;
        showProgress('Reading the media… ' + percent + '%', 0, token);
      });
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

    showProgress('Loading the project…', 0, token);
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
      signalDocumentIdentity('project-file-open');

      if (opfsAvailable && session.projectId !== null) {
        await acquireProjectLock(session.projectId); // fresh id: always granted
        const dir = await getProjectDir(session.projectId, true);
        if (loaded.originalText !== null) await writeFileTo(dir, ENTRY.original, loaded.originalText);
        await writeMediaOnce();
      }
    } finally {
      suppressCapture = false;
    }
    // The opened file IS the saved state: commit it, no draft — the fresh
    // entry starts clean.
    if (opfsAvailable && session.projectId !== null) {
      await commitInitialState(session.projectId);
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
    // Embedder-scheme links reconcile on the embedder's side. The in-page
    // re-attach cannot run in every embedded WebView (a programmatic
    // file-input click is blocked in WKWebView), and attaching in-page would
    // writeMediaOnce() the bytes into OPFS — embedder media deliberately
    // lives outside the browser. The embedder re-points its scheme handler
    // and reloads the player instead.
    if (isEmbedderLinkUrl(desc.url) && typeof window.hyperaudioMediaReconcileHandler === 'function') {
      window.hyperaudioMediaReconcileHandler({
        url: desc.url,
        filename: desc.filename || '',
        sizeBytes: desc.sizeBytes || 0,
        durationSeconds: desc.durationSeconds || 0,
      });
      return;
    }
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
    markProjectActive(id);   // this is now the project you are looking at
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
    // Clean restore: what's on screen IS the saved state, so sign it — an
    // undo can then find its way back to clean. A draft restore leaves the
    // signature unknown (the saved state is not what's on screen), which
    // keeps the previous always-dirty behaviour for that case.
    savedSignature = files.fromDraft ? null : stateSignature();
    signalDocumentIdentity('project-library-open');
  }

  // Switching asks nothing and loses nothing (#456): flush the outgoing
  // project's pending draft to its own directory, hand the editor to the
  // incoming one (draft first — its unsaved edits come back, still dirty),
  // move the per-project lock. Returns false (editor untouched) when the
  // target can't be read.
  /* --------------------------------------------------------------------------
   * Pending transcription as a first-class Recents citizen (#525). From the
   * moment an engine starts, the transcription appears as an in-progress row
   * (virtual — in memory only, so a reload, which kills the engine anyway,
   * leaves no stuck entry). Clicking it switches back to the live loader:
   * the local engines update progress via a null-guarded
   * '#hypertranscript .transcribing-msg' lookup, so re-rendering the captured
   * loader markup lets their message and elapsed time resume painting.
   *
   * Detection is the engines' own signal: they call setTranscriptBusy(true)
   * right after writing their loader, and (false) on completion or error —
   * wrapped here the same way setTranscriptionInfo is. Completion is the
   * birth (hyperaudioInit); busy(false) with no timed spans in the transcript
   * is a failure or cancellation, and the row leaves with the engine.
   * ----------------------------------------------------------------------- */
  let pendingTranscription = null; // { name, loaderHtml } — the row and the view
  // The transcription's IDENTITY (file, URL marker, player src) lives longer
  // than the row: Parakeet's worker can report a phantom error (#529) — which
  // takes the row down, correctly, since the engine SAYS it died — and then
  // recover and complete anyway. If the identity died with the row, that
  // recovered birth stole the name, media and video of whatever project the
  // user was viewing. The identity survives until a birth consumes it, a new
  // transcription replaces it, or a user-initiated import clears it.
  let pendingIdentity = null; // { file, fromUrl, playerSrc }

  function pendingTranscriptionInfo() {
    return pendingTranscription === null ? null : { name: pendingTranscription.name };
  }

  function mediaDisplayName() {
    if (session.mediaFile !== null && session.mediaFile.name) return session.mediaFile.name;
    const player = document.getElementById('hyperplayer');
    const src = player !== null ? player.src : '';
    if (isLinkUrl(src)) { // http(s) or a declared embedder scheme
      try {
        const leaf = decodeURIComponent(new URL(src).pathname.split('/').pop() || '');
        if (leaf !== '') return leaf;
      } catch (e) { /* fall through */ }
    }
    return 'Transcription';
  }

  {
    const originalSetBusy = window.setTranscriptBusy;
    if (typeof originalSetBusy === 'function') {
      window.setTranscriptBusy = function (busy) {
        try {
          const t = document.getElementById('hypertranscript');
          if (busy === true && t !== null) {
            // Carry the transcription's own IDENTITY, not just its loader:
            // switching away replaces session.mediaFile and the player src
            // with the other project's, and the birth reads both — so a
            // completion while viewing another project named the new project
            // after the OTHER file and, worse, paired the transcript with the
            // other project's media. Captured here, restored at the birth.
            const player = document.getElementById('hyperplayer');
            pendingTranscription = { name: mediaDisplayName(), loaderHtml: t.innerHTML };
            pendingIdentity = {
              file: session.mediaFile,
              fromUrl: session.mediaFileFromUrl,
              playerSrc: player !== null ? player.src : '',
            };
            // ENGINE state, distinct from the transcript's aria-busy VIEW
            // state (which switching away deliberately clears): the NEW /
            // transcribe entry points grey on this class, so the gate holds
            // while the engine runs in the background too.
            document.documentElement.classList.add('ha-transcribing');
            // The player already holds the transcription's media, but the
            // caption <track> still holds the PREVIOUS project's vtt — left
            // alone, playing the transcribing video shows the old captions.
            // The one door also arms the late-write guard, so caption.js
            // can't re-apply the stale vtt on the new media's loadedmetadata.
            applyCaptionTrack('', { mode: 'disabled' });
            notifyLibraryChanged(false);
          } else if (busy === false && pendingTranscription !== null) {
            // success is announced by hyperaudioInit (the birth clears the row
            // there); busy(false) with no timed spans means the engine ended
            // without a transcript — an error, and the row goes with it
            if (t === null || t.querySelector('span[data-m]') === null) {
              pendingTranscription = null;
              document.documentElement.classList.remove('ha-transcribing');
              notifyLibraryChanged(false);
            }
          }
        } catch (e) { /* observing only — never break the engine's call */ }
        return originalSetBusy.apply(this, arguments);
      };
    }
  }

  // Registered at module load, BEFORE wireCapture registers onNewTranscript —
  // so the pending identity is restored before the birth gathers it.
  document.addEventListener('hyperaudioInit', () => {
    if (pendingIdentity !== null) {
      session.mediaFile = pendingIdentity.file;
      session.mediaFileFromUrl = pendingIdentity.fromUrl;
      const player = document.getElementById('hyperplayer');
      if (player !== null && pendingIdentity.playerSrc
          && player.src !== pendingIdentity.playerSrc) {
        player.src = pendingIdentity.playerSrc; // the transcription's own media back on the player
      }
      pendingIdentity = null;
    }
    if (pendingTranscription !== null) {
      pendingTranscription = null;
      document.documentElement.classList.remove('ha-transcribing');
      notifyLibraryChanged(false);
    }
  });

  // User-initiated content imports (SRT/VTT/JSON) also dispatch
  // hyperaudioInit; a surviving identity from an errored transcription must
  // not hijack THEIR media. The import paths call this before dispatching.
  function clearPendingTranscription() {
    pendingIdentity = null;
    if (pendingTranscription !== null) {
      pendingTranscription = null;
      document.documentElement.classList.remove('ha-transcribing');
      notifyLibraryChanged(false);
    }
  }
  window.clearPendingTranscription = clearPendingTranscription;

  // An engine that only obtains its media AFTER starting (URL modes that
  // download or resolve first) reports the media src once known. The pending
  // identity and (when the pending view owns the screen) the player follow,
  // exactly as if the src had been on the player before setTranscriptBusy(true).
  window.hyperaudioUpdatePendingMediaSrc = function (url) {
    if (pendingIdentity === null) return false;
    // Canonical (percent-encoded, resolved) form — player.src always reads
    // back canonical, and a raw-vs-canonical mismatch means needless media
    // reloads later (identity restore compares against player.src).
    let canon = url || '';
    try { canon = url ? new URL(url, window.location.href).href : ''; } catch (e) { /* keep raw */ }
    pendingIdentity.playerSrc = canon;
    if (pendingTranscription !== null) {
      pendingTranscription.name = mediaDisplayName2(canon) || pendingTranscription.name;
    }
    const t = document.getElementById('hypertranscript');
    const player = document.getElementById('hyperplayer');
    if (player !== null && canon && t !== null && t.getAttribute('aria-busy') === 'true'
        && player.src !== canon) {
      player.src = canon;
    }
    notifyLibraryChanged(false);
    return true;
  };
  // Name helper for the late-media case: leaf of the reported URL.
  function mediaDisplayName2(url) {
    try {
      const leaf = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      return leaf !== '' ? leaf : null;
    } catch (e) { return null; }
  }

  // Clicking the in-progress row: hand the screen back to the transcription.
  // The current project's pending edits flush to its own draft first; the
  // loader is re-rendered and the engines' progress painting resumes into it.
  // No project owns the screen while watching (projectId null), exactly as
  // during the original loader phase.
  async function switchToPendingTranscription() {
    if (pendingTranscription === null) return false;
    const t = document.getElementById('hypertranscript');
    if (t === null) return false;
    if (t.getAttribute('aria-busy') === 'true') return true; // already watching
    await flushPendingDraft();
    releaseProjectLock();
    session.projectId = null;
    sessionEdited = false;
    updateSaveIndicator();
    suppressCapture = true;
    try {
      t.textContent = '';
      if (pendingTranscription.fragment) {
        t.appendChild(pendingTranscription.fragment); // the SAME nodes, state intact
        pendingTranscription.fragment = null;
      } else {
        t.innerHTML = pendingTranscription.loaderHtml;
      }
      t.setAttribute('aria-busy', 'true');
      t.setAttribute('contenteditable', 'false'); // the loader is not for typing in
      // The transcription's own media on the player too — without this, the
      // pending view kept showing whatever project was on screen before.
      const player = document.getElementById('hyperplayer');
      if (player !== null && pendingIdentity !== null && pendingIdentity.playerSrc
          && player.src !== pendingIdentity.playerSrc) {
        player.src = pendingIdentity.playerSrc;
      }
      // ... and the project we came FROM applied its captions at open; the
      // transcribing media has none yet.
      applyCaptionTrack('', { mode: 'disabled' });
    } finally {
      suppressCapture = false;
    }
    notifyLibraryChanged(false);
    return true;
  }

  // Leaving a transcription in flight needs no consent any more (#525): the
  // in-progress Recents row shows where it lives, nothing is lost, and the
  // way back is one click. What remains of the old dialog is its cleanup —
  // the busy ATTRIBUTE must not follow us to the next view, and it is
  // cleared directly rather than via setTranscriptBusy, which is the
  // ENGINE's lifecycle signal (the wrapper above reads busy(false) without
  // spans as an engine failure and would drop the in-progress row).
  function leaveTranscriptionView() {
    const t = document.getElementById('hypertranscript');
    if (t !== null && t.getAttribute('aria-busy') === 'true') {
      // Move the loader's LIVE NODES aside rather than snapshotting HTML: a
      // string copy goes stale the moment the engine repaints (the
      // 'Preparing model' flash was exactly that), and element identity is
      // what the engines' null-guarded '.transcribing-msg' lookups key on —
      // the same nodes coming back means whatever state they carried comes
      // back with them, with nothing to age.
      if (pendingTranscription !== null && t.querySelector('.transcribing-msg') !== null) {
        const fragment = document.createDocumentFragment();
        while (t.firstChild) fragment.appendChild(t.firstChild);
        pendingTranscription.fragment = fragment;
      }
      t.removeAttribute('aria-busy');
      // busy(true) also turned editing OFF, and that must not follow us to
      // the project either: left as-is, every transcript opened while a
      // transcription runs has no caret and takes no edits.
      t.setAttribute('contenteditable', 'true');
    }
    return true;
  }

  async function switchToProject(id) {
    if (!opfsAvailable) return false;
    if (id === session.projectId) {
      // Normally a no-op — but mid-transcription the SCREEN holds the loader
      // while the session still points at this project (no birth has happened
      // yet), and the no-op stranded the user staring at it with no way back
      // (#525). When busy, fall through and re-apply the project from disk.
      const t = document.getElementById('hypertranscript');
      if (t === null || t.getAttribute('aria-busy') !== 'true') return true;
    }
    leaveTranscriptionView();
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
  // Deleting the CURRENT project keeps the document ON SCREEN — the undo's
  // raw material — while the library entry and directory go. The panel shows
  // a placeholder row carrying Restore (which re-homes the on-screen
  // document) in the deleted row's place; any navigation elsewhere replaces
  // the screen and withdraws the offer. Returns { wasCurrent }.
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
    return { wasCurrent };
  }

  // Undo for deleting the current project: re-home the on-screen document —
  // still fully held by the session — under a fresh id.
  async function restoreCurrentAsNewProject(starred, stamps) {
    if (!opfsAvailable || !session.active || session.projectId !== null) return null;
    session.projectId = newProjectId();
    const id = session.projectId;
    await acquireProjectLock(id);
    await writeOriginToProjectDir();
    await writeMediaOnce();
    // a rebirth: the on-screen content IS the new baseline — commit it clean
    await commitInitialState(id);
    // A restore is an UNDO, not new work: carry the original entry's ordering
    // stamps so the row reappears where it lived (the panel orders by
    // modifiedAt), rather than teleporting to the top as freshly written.
    // lastActiveAt stays fresh — the restored project IS the one on screen,
    // and a reload should return to it.
    if (stamps && (stamps.modifiedAt || stamps.createdAt)) {
      await updateLibrary((lib) => {
        const entry = lib.projects.find((p) => p.id === id);
        if (entry !== undefined) {
          if (stamps.modifiedAt) entry.modifiedAt = stamps.modifiedAt;
          if (stamps.createdAt) entry.createdAt = stamps.createdAt;
        }
      });
    }
    sessionEdited = false;
    updateSaveIndicator();
    if (starred === true) await setProjectStarred(id, true);
    notifyLibraryChanged(false);
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
      revealTranscript();
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
      syncProjectsHint(lib); // self-heal a cleared/stale hint (#473)
      // Most recently ACTIVE first; a corrupt head entry falls through to the
      // next rather than abandoning the boot (the demo stays for none).
      for (const entry of sortByLastActive(lib.projects)) {
        if (await switchToProject(entry.id)) break;
      }
    } catch (e) {
      console.warn('hyperaudio-save: boot restore failed, leaving demo', e);
    } finally {
      revealTranscript(); // never leave the anti-flash hide up (#473)
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
    // #456), so the menu carries no Save item. The project items lead their
    // top-level submenus (#470: Import and Export are separate categories);
    // Export Project is the explicit way to take a portable .hyperaudio out
    // of the browser — the only save-ish download.
    const importList = document.querySelector('#file-import-submenu ul');
    if (importList !== null) {
      importList.insertAdjacentHTML('afterbegin',
        '<li><a id="project-open-hyperaudio">Project (.hyperaudio)</a></li>');
    } else {
      dropdown.insertAdjacentHTML('beforeend',
        '<li><a id="project-open-hyperaudio">Project (.hyperaudio)</a></li>');
    }
    const exportList = document.querySelector('#file-export-submenu ul');
    if (exportList !== null) {
      exportList.insertAdjacentHTML('afterbegin',
        '<li><a id="project-export-hyperaudio">Project (.hyperaudio)</a></li>');
    } else {
      dropdown.insertAdjacentHTML('beforeend',
        '<li><a id="project-export-hyperaudio">Project (.hyperaudio)</a></li>');
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

    // Land the pending draft on the way out (#519): the autosave debounce is
    // 1.5 s and nothing flushed it at teardown, so closing the tab (or
    // switching apps on mobile) dropped the newest keystrokes — the last
    // sentence typed, the part most likely to be noticed missing.
    // visibilitychange→hidden fires on tab/app switches, usually well before
    // a close; pagehide covers iOS Safari, where beforeunload often does not.
    // Neither can await — the flush is INITIATED and in practice lands (both
    // fire earlier in teardown than beforeunload, and OPFS writes are fast at
    // draft sizes). flushPendingDraft is idempotent across the pair firing in
    // one teardown: it clears the timer, writes only when a write is actually
    // pending, and otherwise just awaits the chain — so hide→show→hide and
    // visibilitychange-then-pagehide cannot double-write or race the chain.
    // beforeunload stays what #449/#456 narrowed it to (the genuine-loss
    // warning) — this is about landing the write, not warning.
    const flushOnHide = () => {
      if (session.active && autosavePending) {
        flushPendingDraft().catch((e) => console.warn('hyperaudio-save: hide flush failed', e));
      }
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushOnHide();
    });
    window.addEventListener('pagehide', flushOnHide);

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
          // Optional fields (spec § 3.5, format 1.3) — persisted so the info
          // modal's Time taken / Processing rows survive a reload (#457).
          if (info && typeof info.seconds === 'number' && Number.isFinite(info.seconds)) {
            session.provenance.seconds = Math.round(info.seconds * 10) / 10;
          }
          if (info && info.device) {
            session.provenance.device = String(info.device);
          }
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
    // blur doesn't bubble; focusout does — end-of-edit capture for the
    // transcript. Only when an edit is actually pending: the transcript is a
    // contenteditable that takes focus on any click into it (and Chrome
    // restores that focus after an app switch), so an unconditional
    // focusout-marks-dirty turned mere focus traffic — click a word, click
    // away; leave the window, come back, click anything — into a phantom
    // dirty dot. Every real edit fires `input` first, which sets
    // autosavePending; this listener only hastens that flush.
    document.addEventListener('focusout', (event) => {
      const t = event.target;
      if (t && t.closest && t.closest('#hypertranscript') !== null && autosavePending) {
        scheduleAutosave();
      }
    });
    // the strike-through toolbar mutates word styles without emitting input
    const strikeBtn = document.querySelector('#strikethrough');
    if (strikeBtn !== null) strikeBtn.addEventListener('click', scheduleAutosave);
    document.addEventListener('hyperaudioGenerateCaptionsFromTranscript', () => {
      // the engine-driven caption pass during project birth is part of the
      // committed v0, not an edit — see birthInProgress
      if (birthInProgress) return;
      scheduleAutosave();
    });
    // Caption edits from the caption editor itself (#505). EDIT_SCOPE already
    // catches TYPING there, because the caption inputs fire a real `input`
    // event — but insert, merge and delete are onclick handlers that rewrite
    // the caption list silently, so the project stayed clean over a change
    // that was then lost on close. editor-main announces all four from its one
    // choke point; typing therefore signals twice, which costs nothing (this
    // only sets the flag and restarts the debounce). Same birth guard as
    // above: a caption pass belonging to the committed v0 is not an edit.
    document.addEventListener('hyperaudioCaptionsEdited', () => {
      if (birthInProgress) return;
      scheduleAutosave();
    });
    // Undo/redo (#400): a restore that lands the editor EXACTLY back on the
    // last committed state clears the dirty dot and retires the draft — the
    // project is the save again, so there is nothing to lose. Compared by
    // signature, not by step-counting, so a pending NON-transcript edit
    // (summary, captions, options) keeps the dot on: undo can't revert those,
    // and the project genuinely differs from the save. Restores that DON'T
    // land on the save re-dirty through the synthetic input the history
    // module dispatches, like any other edit.
    let restoreRecheckTimer = null;
    const attemptCleanAfterRestore = () => {
      if (!session.active || savedSignature === null || !sessionEdited) return;
      if (stateSignature() !== savedSignature) return;
      cleanAfterRestore();
    };
    document.addEventListener('hyperaudioTranscriptRestored', () => {
      // Two attempts: now, and once more after the idle reconciliation
      // window. The perf rework (#517) defers caption regeneration to a ~3s
      // idle queue, so a restore that lands the TRANSCRIPT exactly on the
      // saved state can still carry the pre-undo captions on the track when
      // this event fires — the signature legitimately mismatches until the
      // deferred pass catches the track up. The recheck re-runs the same
      // guards fresh: an edit landing meanwhile keeps the dot on.
      clearTimeout(restoreRecheckTimer);
      attemptCleanAfterRestore();
      restoreRecheckTimer = setTimeout(attemptCleanAfterRestore, 3400);
    });
    function cleanAfterRestore() {
      sessionEdited = false;
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
      autosavePending = false;
      updateSaveIndicator();
      // The draft predates the undo and now describes a dirtier state than
      // the screen; left in place it would resurrect as "unsaved edits" on
      // reload. Ride the snapshot chain so a queued draft write can't
      // interleave, and re-check the flag there — an edit that lands while
      // this waits makes the retirement wrong, so it must stand down.
      if (opfsAvailable && hasProjectLock && session.projectId !== null) {
        const id = session.projectId;
        snapshotChain = snapshotChain.then(async () => {
          if (sessionEdited || id !== session.projectId) return;
          const dir = await getProjectDir(id, false);
          await dir.removeEntry(DRAFT_FILE).catch(() => {});
          await updateLibrary((lib) => {
            const entry = lib.projects.find((p) => p.id === id);
            if (entry !== undefined) entry.lastDraftAt = 0;
          });
          notifyLibraryChanged(false);
        }).catch((e) => console.warn('hyperaudio-save: draft retirement failed', e));
      }
    }
    ['#remove-gaps-enabled', '#remove-gaps-threshold', '#remove-gaps-buffer', '#show-speakers', '#show-timecodes']
      .forEach((selector) => {
        const el = document.querySelector(selector);
        if (el !== null) {
          el.addEventListener('change', scheduleAutosave);
          el.addEventListener('input', scheduleAutosave);
        }
      });
  }

  /* --------------------------------------------------------------------------
   * Export progress (#502). Building a container reads the media out of OPFS,
   * may download it over the network, and packs the whole thing into a blob —
   * seconds to minutes on real media, during which the app looked completely
   * inert. The only pre-existing signal was a confirm dialog above 500MB, so
   * an ordinary 100MB interview got nothing at all.
   *
   * A fixed pill rather than a notice in #side-notices: that panel is an
   * off-canvas drawer on the small-screen layout, so a notice there is
   * invisible on exactly the devices where the wait is longest. role=status +
   * aria-live announces each stage without stealing focus.
   * ----------------------------------------------------------------------- */
  let progressEl = null;
  let progressHoldUntil = 0;
  // Operations overlap — an open can still be seeding OPFS when an export
  // starts — and they share one pill. Without ownership the older operation's
  // cleanup wiped the newer one's message (caught by a full-suite run, where
  // a slow open's finally landed mid-export and cleared a held message).
  // beginProgress hands out a token; stale tokens are ignored.
  let progressToken = 0;
  function beginProgress() {
    progressToken += 1;
    return progressToken;
  }

  // holdMs pins a message for a moment against the routine progress stream.
  // Needed because packing fires onUpdate every few milliseconds: a message
  // answering something the USER just did ("still building", after a second
  // click) was overwritten before it could be read — the test caught nothing
  // because it read the text synchronously, which a human cannot do.
  function showProgress(message, holdMs, token) {
    if (typeof document === 'undefined') return;
    if (token !== undefined && token !== progressToken) return; // superseded
    const now = Date.now();
    if (!holdMs && now < progressHoldUntil) return; // a held message is on screen
    if (progressEl === null) {
      progressEl = document.createElement('div');
      progressEl.id = 'project-progress';
      progressEl.setAttribute('role', 'status');
      progressEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(progressEl);
    }
    progressEl.textContent = message;
    progressHoldUntil = holdMs ? now + holdMs : 0;
  }

  function hideProgress(token) {
    if (token !== undefined && token !== progressToken) return; // not ours to clear
    progressHoldUntil = 0;
    if (progressEl !== null) {
      progressEl.remove();
      progressEl = null;
    }
  }

  function showTabGuardBanner() {
    const anchor = document.getElementById('side-notices');
    if (anchor === null) return;
    if (document.getElementById('tab-guard-banner') !== null) return;
    const el = document.createElement('div');
    el.id = 'tab-guard-banner';
    el.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = 'This project is open in another tab — autosave and crash recovery are active there. You can still edit and save here, or switch to a different project.';
    // Dismissible per appearance: the condition is real, so no persistence —
    // contesting the same (or another) project later shows it again.
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.textContent = '✕';
    dismiss.addEventListener('click', () => { el.remove(); });
    el.appendChild(text);
    el.appendChild(dismiss);
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
    buildFlattenedProjectBlob, // #455: fresh container around a rendered export (media-export modal)
    // export naming and any future UI read the title through here
    getProjectTitle: () => session.title || (session.mediaFile !== null ? session.mediaFile.name : '') || '',
    // the document exports (#467) read the transcript through here: the same
    // speaker-preserving, caption-mode-aware gather the save path uses
    getTranscriptJson: () => getEditorTranscriptJson(),
    loadJSZip, // shared vendored-zip loader (the .docx export packages with it)
    // The project's media as a FRESH File. An object URL made from an OPFS
    // file is a snapshot: once that file is rewritten (any save that re-writes
    // media does), the URL still plays from buffered data but can no longer be
    // read back — which is how the media exporter met "Failed to fetch" on
    // some projects and not others. Callers that need the BYTES ask here
    // rather than re-reading the player's src.
    currentMediaFile: async () => {
      if (session.projectId !== null) {
        try {
          const root = await navigator.storage.getDirectory();
          const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(session.projectId);
          const mediaDir = await dir.getDirectoryHandle('media');
          for await (const [, handle] of mediaDir.entries()) {
            if (handle.kind === 'file') return await handle.getFile();
          }
        } catch (e) { /* no stored media — fall through */ }
      }
      return session.mediaFile;
    },
    openFromFile,
    autosaveNow: writeDraft,
    isDirty,
    opfsAvailable,
    // The one dialog chassis (#451/#506): other modules raise their notices
    // through this rather than growing their own markup — the caption
    // divergence warning (editor-main) is the first outside caller.
    dialog: projectDialog,
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
      pendingTranscription: pendingTranscriptionInfo,
      openPendingTranscription: switchToPendingTranscription,
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

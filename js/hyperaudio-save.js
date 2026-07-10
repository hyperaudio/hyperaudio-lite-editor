/*
 * ============================================================================
 * .hyperaudio PROJECT SAVE — format, container, OPFS working copy, UI
 * ============================================================================
 *
 * Implements the .hyperaudio format v1.0 (full spec + worked example: issue #403).
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
  const FORMAT_VERSION = '1.0';
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

  // media.path MUST be media/<filename>: one segment, no "..", nothing absolute
  // (spec § 10.2). The zip is only ever read by known names, so this is the one
  // file-supplied name we accept — and only in this shape.
  function validateMediaPath(path) {
    return typeof path === 'string'
      && /^media\/[^/\\]+$/.test(path)
      && path.indexOf('..') === -1;
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
    const project = {
      format: FORMAT_NAME,
      formatVersion: FORMAT_VERSION,
      generator: {
        name: 'hyperaudio-lite-editor',
        version: state.generatorVersion || '',
      },
      created: state.created,
      modified: state.modified,
      media: state.media,
      options: {
        gapRemoval: state.options.gapRemoval,
        captions: { updateFromTranscript: state.options.updateCaptionsFromTranscript !== false },
        view: state.options.view,
      },
      texts: {
        title: state.texts.title || '',
        language: state.texts.language || '',
        summary: state.texts.summary || '',
        topics: Array.isArray(state.texts.topics) ? state.texts.topics : [],
      },
      transcript: state.transcript,
    };
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
      zip.file(MEDIA_DIR + files.media.name, files.media.data, { compression: 'STORE', binary: true });
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
      const text = await entry.async('string');
      if (text.length > TEXT_ENTRY_MAX_BYTES) {
        throw rejection('entry-too-large', `${name} exceeds the ${TEXT_ENTRY_MAX_BYTES} byte cap`);
      }
      return text;
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
    checkFormatVersion, validateMediaPath, validateProjectJson,
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
    hasOriginal: false,
    originalJson: null, // the origin as serialized JSON (in-memory copy; work/ holds it across reloads)
  };
  let suppressCapture = false; // true while apply() replays a loaded project
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
      // The player is on a remote URL (URL-mode transcription): any File
      // captured for a PREVIOUS project is stale — the URL wins.
      // Kept as a link descriptor in the WORKING COPY only — saveToFile()
      // refuses to write it into a downloadable container (v1 writes kind
      // "original" only; "link" is a future formula, spec § 7.2).
      return { kind: 'link', path: null, url: src, filename: '', mimeType: '', durationSeconds: duration, sizeBytes: 0 };
    }
    if (session.mediaFile !== null) {
      return {
        kind: 'original',
        path: MEDIA_DIR + session.mediaFile.name,
        url: null,
        filename: session.mediaFile.name,
        mimeType: session.mediaFile.type || '',
        durationSeconds: duration,
        sizeBytes: session.mediaFile.size,
      };
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
    const titleField = document.querySelector('#save-localstorage-filename');
    const summaryEl = document.getElementById('summary');
    const topicsEl = document.getElementById('topics');
    const media = currentMediaDescriptor();
    const title = (titleField !== null && titleField.value.trim() !== '')
      ? titleField.value.trim()
      : (media.filename || 'project');

    return {
      generatorVersion: versionMeta !== null ? versionMeta.content : '',
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
      const titleField = document.querySelector('#save-localstorage-filename');
      if (titleField !== null && texts !== null && texts.title) titleField.value = texts.title;

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
    try {
      const state = gather();
      const dir = await getWorkDir(true);
      await writeFileTo(dir, ENTRY.json, serializeProjectJson(buildProjectJson(state)));
      await writeFileTo(dir, ENTRY.html, state.html);
      const vtt = getCaptionsVtt();
      if (vtt !== '') await writeFileTo(dir, ENTRY.captions, vtt);
      await patchAppState({ lastWorkWriteAt: Date.now() });
      try { localStorage.setItem(WORK_HINT_KEY, '1'); } catch (e) { /* private mode */ }
    } catch (e) {
      console.warn('hyperaudio-save: autosave failed', e);
    }
  }

  function scheduleAutosave() {
    if (!opfsAvailable || !session.active || suppressCapture) return;
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

  async function saveToFile() {
    const mediaFile = await resolveMediaFile();
    const player = document.querySelector('#hyperplayer');
    if (mediaFile === null) {
      if (player !== null && /^https?:/i.test(player.src)) {
        alert('This project references remote media (a URL). Version 1 of the .hyperaudio format only saves projects with a local media file — the "link" formula is coming later.');
      } else {
        alert('No media loaded — there is nothing to save yet.');
      }
      return;
    }

    const lowMem = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 4;
    const warnAt = lowMem ? LARGE_MEDIA_WARN_BYTES_LOWMEM : LARGE_MEDIA_WARN_BYTES;
    if (mediaFile.size > warnAt) {
      const mb = Math.round(mediaFile.size / (1024 * 1024));
      if (!confirm(`The media file is large (~${mb} MB). Building the .hyperaudio file needs roughly that much memory and may take a while. Continue?`)) {
        return;
      }
    }

    session.active = true;
    if (session.created === null) session.created = nowIso();

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
      media: { name: mediaFile.name, data: mediaFile },
    }, JSZipImpl, 'blob');

    const safeTitle = (state.texts.title || 'project')
      .replace(/\.hyperaudio$/i, '')
      .replace(/[\\/:*?"<>|]+/g, '-').trim() || 'project';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeTitle + FILE_EXTENSION;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    await patchAppState({ lastDownloadAt: Date.now() });
  }

  async function openFromFile(file) {
    if (await isDirty()) {
      const proceed = confirm('The current project has changes that were never downloaded as a .hyperaudio file. Opening this file will REPLACE it.\n\nPress Cancel to go back (you can save it from FILE → Save Project first), or OK to replace it.');
      if (!proceed) return;
    }

    let loaded;
    try {
      const JSZipImpl = await loadJSZip();
      loaded = await unzipProject(file, JSZipImpl);
    } catch (e) {
      const messages = {
        'version-major': 'This project was saved by a newer version of the editor and cannot be opened here. Please update the editor.',
        'media-kind': 'This project uses a media formula this editor does not support yet. Please update the editor.',
        'entry-too-large': 'This file contains an oversized entry and was refused for safety.',
        'unreadable': 'This is not a readable .hyperaudio file.',
      };
      alert(messages[e.code] || messages['unreadable']);
      return;
    }

    if (loaded.mediaData !== null && loaded.mediaEntryName !== null) {
      const mimeType = loaded.project !== null ? (loaded.project.media.mimeType || '') : '';
      loaded.mediaFile = new File([loaded.mediaData], loaded.mediaEntryName, { type: mimeType });
    } else {
      loaded.mediaFile = null;
      if (!loaded.recovered && loaded.project.media.kind === 'link') {
        alert('Note: this project references its media by URL — it is not self-contained. Playback will use the remote URL.');
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
      session.hasOriginal = loaded.originalText !== null;
      session.originalJson = loaded.originalText;

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
        alert('The project file was not fully conformant; the transcript was recovered from its HTML copy. Saving again will produce a fully conformant file.');
      }
    }
  }

  // Boot restore: the synchronous localStorage hint decides whether to probe
  // OPFS at all; the static demo transcript in index.html is simply replaced.
  async function restoreFromWork() {
    try {
      const dir = await getWorkDir(false);
      const jsonText = await readTextFrom(dir, ENTRY.json);
      if (jsonText === null) {
        try { localStorage.removeItem(WORK_HINT_KEY); } catch (e) { /* ignore */ }
        return;
      }
      const project = JSON.parse(jsonText);
      const validation = validateProjectJson(project);
      if (!validation.ok) {
        console.warn('hyperaudio-save: work copy failed validation, leaving demo', validation.errors);
        return;
      }
      const mediaFile = project.media.kind === 'original'
        ? await readMediaFileFromWork(project.media.filename) : null;
      const captionsVtt = await readTextFrom(dir, ENTRY.captions);
      const originalText = await readTextFrom(dir, ENTRY.original);

      apply({ recovered: false, project, captionsVtt, mediaFile });
      session.active = true;
      session.created = project.created || nowIso();
      session.provenance = project.provenance || null;
      session.language = (project.texts && project.texts.language) || '';
      session.mediaFile = mediaFile;
      session.hasOriginal = originalText !== null;
      session.originalJson = originalText;
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
      + '<li class="menu-title"><span>Project</span></li>'
      + '<li><a id="project-save-hyperaudio">Save Project (.hyperaudio)</a></li>'
      + '<li><a id="project-open-hyperaudio">Open Project…</a></li>');

    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'project-open-input';
    input.accept = FILE_EXTENSION;
    input.style.display = 'none';
    document.body.appendChild(input);

    document.querySelector('#project-save-hyperaudio').addEventListener('click', () => {
      saveToFile().catch((e) => {
        console.error('hyperaudio-save: save failed', e);
        alert('Saving the project failed: ' + e.message);
      });
    });
    document.querySelector('#project-open-hyperaudio').addEventListener('click', () => {
      input.value = '';
      input.click();
    });
    input.addEventListener('change', () => {
      if (input.files.length === 1) {
        openFromFile(input.files[0]).catch((e) => {
          console.error('hyperaudio-save: open failed', e);
          alert('Opening the project failed: ' + e.message);
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
          }
        });
      });

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

    // Autosave triggers: transcript edits, caption regeneration, option changes.
    const transcriptEl = document.querySelector('#hypertranscript');
    if (transcriptEl !== null) {
      transcriptEl.addEventListener('input', scheduleAutosave);
      transcriptEl.addEventListener('blur', scheduleAutosave);
    }
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

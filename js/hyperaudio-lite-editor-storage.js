/*
 * HyperTranscriptStorage class
 * @param {string} hypertranscript - the html of the hypertranscript
 * @param {string} video - the url of the video
 * @param {string} summary - the text of the summary
 * @param {array} topics - an array of topics
 * @param {string} captions - VTT format
 * @param {object} meta - entry metadata: display name, media key, timestamps,
 *                        caption-sync flag (see below)
 * @return {void}
 */
class HyperTranscriptStorage {
  constructor(hypertranscript, video, summary, topics, captions, meta) {
    this.hypertranscript = hypertranscript;
    this.video = video;
    this.summary = summary;
    this.topics = topics;
    this.captions = captions;
    this.meta = meta;
  }
}

/*
 * Storage model (#434)
 *
 * Entries are keyed by a STABLE GENERATED ID (`hyperaudio:doc:<id>`), never by
 * their display name. The name lives in meta.name, so renaming is a one-field
 * update and two entries may share a display name candidate (the second gets a
 * " (2)" suffix) without one overwriting the other. Cached local media in
 * IndexedDB is keyed by meta.mediaKey — the doc key for new entries — so a
 * rename never has to re-key a (possibly large) media blob.
 *
 * meta: {
 *   name:    display name shown in Recents,
 *   mediaKey: IndexedDB key of the cached local media (if any),
 *   created / updated: epoch ms; `updated` drives the list order,
 *   updateCaptionsFromTranscript: existing caption-sync flag,
 * }
 *
 * LEGACY entries (`<name>.hyperaudio`, where the key IS the name) are migrated
 * in place the first time the list renders: same JSON, new key, name/mediaKey
 * carried into meta (media stays under its old key via mediaKey). An entry
 * that does not parse is left on its legacy key — still listed, still
 * deletable, and the defensive read path keeps clicks from throwing (#410).
 */

const fileExtension = ".hyperaudio";
const DOC_KEY_PREFIX = "hyperaudio:doc:";
const MEDIA_DATABASE = "hyperaudioMedia";
const MEDIA_STORE = "media";

// The storage key of the entry currently loaded in the editor (null when the
// document on screen has never been saved). Save updates this entry in place;
// delete clears it.
let activeDocKey = null;

// docKey + '|' + blob-URL of the media most recently written to IndexedDB, so
// debounced autosaves skip re-encoding an unchanged blob (see the save path).
let savedMediaStamp = null;

// True only while the auto-add save runs (hyperaudioInit). The engines dispatch
// that event BEFORE regenerating captions, so the caption track — and the
// summary/topics panels — still hold the PREVIOUS document's content at that
// moment; capturing them stamped the intro demo's captions into fresh entries.
// An auto-added entry stores no derived state: captions regenerate from the
// transcript on load, and the first edit-autosave captures the real ones.
let suppressDerivedCapture = false;

function isDocKey(key) {
  return typeof key === "string" && key.startsWith(DOC_KEY_PREFIX);
}

function isLegacyKey(key) {
  return typeof key === "string" && !isDocKey(key) && key.indexOf(fileExtension) > 0;
}

function legacyNameFromKey(key) {
  return key.substring(0, key.lastIndexOf(fileExtension));
}

function newDocKey() {
  return DOC_KEY_PREFIX + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// Display name of an entry: meta.name, else (legacy) the name embedded in the
// key, else a fallback so a malformed entry still renders as a row.
function entryName(key, entry) {
  if (entry && entry.meta && typeof entry.meta.name === "string" && entry.meta.name !== "") {
    return entry.meta.name;
  }
  if (isLegacyKey(key)) {
    return legacyNameFromKey(key);
  }
  return "Untitled";
}

// IndexedDB key of an entry's cached media. Migrated entries carry their
// legacy name here; unparseable legacy entries fall back to the key's name so
// deleting one still clears its media.
function entryMediaKey(key, entry) {
  if (entry && entry.meta && typeof entry.meta.mediaKey === "string" && entry.meta.mediaKey !== "") {
    return entry.meta.mediaKey;
  }
  return isLegacyKey(key) ? legacyNameFromKey(key) : null;
}

// A display name not used by any other entry: "name", else "name (2)", "name
// (3)", ... `excludeKey` lets an entry keep (or re-save under) its own name.
function uniqueEntryName(desired, storage, excludeKey) {
  const names = new Set();
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key === excludeKey) continue;
    if (isDocKey(key) || isLegacyKey(key)) {
      names.add(entryName(key, readTranscriptEntry(key, storage)));
    }
  }
  if (!names.has(desired)) return desired;
  let n = 2;
  while (names.has(`${desired} (${n})`)) n++;
  return `${desired} (${n})`;
}

// All saved entries as {key, name, updated}, last-edited first — an entry
// never edited since creation sorts by its creation date (save stamps both,
// migration stamps created). Ties, and entries with no date at all, break
// alphabetically.
function listDocEntries(storage) {
  const rows = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!isDocKey(key) && !isLegacyKey(key)) continue;
    const entry = readTranscriptEntry(key, storage);
    const meta = (entry && entry.meta) || {};
    rows.push({
      key,
      name: entryName(key, entry),
      updated: meta.updated || meta.created || 0,
      starred: meta.starred === true,
    });
  }
  rows.sort((a, b) => (b.updated - a.updated) || a.name.localeCompare(b.name));
  return rows;
}

/*
 * Star / unstar an entry (#440). Like rename, this deliberately does not
 * touch `updated` — pinning must not reorder anything by itself.
 * @return {boolean} whether the change was applied
 */
function setTranscriptStarred(fileKey, starred, storage = window.localStorage) {
  const entry = readTranscriptEntry(fileKey, storage);
  if (entry === null) return false;
  entry.meta = Object.assign({}, entry.meta, { starred: starred === true });
  try {
    storage.setItem(fileKey, JSON.stringify(entry));
  } catch (error) {
    console.error('Error starring transcript:', error);
    return false;
  }
  return true;
}

// One-time upgrade of legacy name-keyed entries to ID-keyed entries. Runs
// every list render but is a no-op once nothing legacy-parseable remains.
function migrateLegacyEntries(storage) {
  const legacyKeys = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (isLegacyKey(key)) legacyKeys.push(key);
  }
  legacyKeys.forEach((key) => {
    const entry = readTranscriptEntry(key, storage);
    if (!entry || typeof entry.hypertranscript !== "string") return; // leave it; still listed + deletable
    const name = legacyNameFromKey(key);
    // The true creation date was never recorded — stamp migration time as the
    // proxy so the entry sorts by date (updated || created) from here on.
    entry.meta = Object.assign({}, entry.meta, { name, mediaKey: name, created: Date.now() });
    try {
      storage.setItem(newDocKey(), JSON.stringify(entry));
      storage.removeItem(key);
    } catch (e) {
      // quota — keep the legacy key rather than risk losing the entry
      console.error("Could not migrate saved transcript:", e);
    }
  });
}

/*
 * Completely remove the existing caption <track> and insert a fresh, empty one.
 *
 * On a Recents (or any media) load the <video> and its <track> are reused. The
 * track stays in 'showing' mode across the swap, so Chromium can keep the
 * PREVIOUS media's active cue *painted* even after track.src is reassigned — the
 * new media starts at currentTime 0, where often no new cue is active yet, so
 * the caption region never repaints and the old line lingers (the "double
 * captions" of #356 / #287). Removing the <track> element drops its rendered
 * output immediately; a fresh element cannot carry stale cues or stale paint.
 *
 * @return {HTMLTrackElement|null} the fresh, empty track (or null if no player)
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

/*
 * Render the HyperTranscript in the DOM
 * @param {object} hypertranscriptstorage - the parsed entry
 * @param {string} mediaKey - IndexedDB key for locally cached media
 * @return {void}
 */
function renderTranscript(
  hypertranscriptstorage,
  mediaKey,
  hypertranscriptDomId = 'hypertranscript',
  videoDomId = 'hyperplayer',
  vttId = 'hyperplayer-vtt',
  hypertranscriptHolder = '.transcript-holder',
) {
  // Tear down the previous media's captions completely before loading the new
  // file, so a stale cue from the old transcript can't stay painted (#356/#287).
  resetCaptionTrack(videoDomId, vttId);

  // Re-stamp the media reference from the entry itself so the interactive-
  // transcript export can offer it (meta.mediaRef, saved with the doc).
  // Backfill for entries saved before that field existed: an auto-added
  // entry's NAME defaults to the media filename, so a name that still looks
  // like one IS the reference (the next autosave then persists it). A doc
  // renamed to something without a media extension clears the stamp instead —
  // offering stale previously-loaded media would be worse than offering none.
  const loadedVideo = document.getElementById(videoDomId);
  if (loadedVideo) {
    const meta = hypertranscriptstorage.meta || {};
    let storedRef = (typeof meta.mediaRef === 'string') ? meta.mediaRef : '';
    if (storedRef === '' && typeof meta.name === 'string' &&
        /\.(mp4|webm|ogv|ogg|mov|m4v|mkv|mp3|m4a|wav|aac|flac|opus)$/i.test(meta.name.trim())) {
      storedRef = meta.name.trim();
    }
    if (storedRef !== '') {
      loadedVideo.dataset.mediaRef = storedRef;
    } else {
      delete loadedVideo.dataset.mediaRef;
    }
  }

  let hypertranscriptElement = document.getElementById(hypertranscriptDomId);

  if (hypertranscriptElement) {
    hypertranscriptElement.innerHTML = hypertranscriptstorage['hypertranscript'];
  } else {
    transcriptCache.innerHTML = "";
    //caption page active, put it in the cache
    transcriptCache.innerHTML = hypertranscriptstorage['hypertranscript'];

    hypertranscriptElement = transcriptCache;
    document.querySelectorAll(hypertranscriptHolder)[0].innerHTML = hypertranscriptElement.innerHTML;
  }

  // check to see if file is local
  if (hypertranscriptstorage['video'].startsWith("http") === true) {
    document.getElementById(videoDomId).src = hypertranscriptstorage['video'];
  } else {
    // load from indexedDB — clearing the previous (e.g. demo, or prior doc's
    // remote) src FIRST: it would otherwise linger until the blob arrives, or
    // forever if the cached media is missing, and an http src outranks this
    // doc's own media reference in guessMediaSrc (the interactive export
    // would offer the WRONG media).
    const playerEl = document.getElementById(videoDomId);
    playerEl.removeAttribute('src');
    playerEl.load();
    getMedia(MEDIA_DATABASE, MEDIA_STORE, mediaKey);
  }

  document.getElementById("summary").innerHTML = hypertranscriptstorage['summary'];
  document.getElementById("topics").innerHTML = getTopicsString(hypertranscriptstorage['topics']);

  // backward compatibility – check that captions exist, if not generate

  if (hypertranscriptstorage['captions'] === undefined) { //backward compatibility for transcripts without captions
    const capEvent = new CustomEvent('hyperaudioGenerateCaptionsFromTranscript');
    document.dispatchEvent(capEvent);
  } else {
    // stop caption.js inserting VTT upon insertion of new video

    document.getElementById(vttId).src = hypertranscriptstorage['captions'];
    // the fresh track (resetCaptionTrack) defaults to 'disabled'; restore the
    // 'showing' mode the stored-caption path previously relied on (the reused
    // track carried it across loads) so the new captions actually display
    const video = document.getElementById(videoDomId);
    if (video !== null && video.textTracks[0] !== undefined) {
      video.textTracks[0].mode = 'showing';
    }
    //remove data:text/vtt, and decode
    let plainVtt = decodeURIComponent(hypertranscriptstorage['captions'].split(',')[1]);

    if (hypertranscriptstorage['meta'] !== undefined && hypertranscriptstorage['meta'].updateCaptionsFromTranscript !== undefined) {
      updateCaptionsFromTranscript = hypertranscriptstorage['meta'].updateCaptionsFromTranscript;
    } else {
      updateCaptionsFromTranscript = true;
    }

    captionCache = null;

    populateCaptionEditorFromVtt(plainVtt);
  }

  let hypertranscript = "";
  if (hypertranscriptElement && document.querySelector("#hypertranscript")) {
    hypertranscript = document.querySelector("#hypertranscript").innerHTML.replace(/ class=".*?"/g, '');
  } else {
    //grab it from the cache
    hypertranscript = transcriptCache.innerHTML.replace(/ class=".*?"/g, '');
  }

  document.querySelector('#download-html').setAttribute('href', 'data:text/html,'+encodeURIComponent(hypertranscript));

  const itDownloadEvent = new CustomEvent('hyperaudioTranscriptLoaded');
  document.dispatchEvent(itDownloadEvent);

  //maybe better called using hyperaudioInit event?
  if (captionMode !== true) {
    hyperaudio();
  } else {
    transcriptRequiresInit = true;
  }

}

function getTopicsString(topics) {
  let topicsString = "";
  if (topics && topics !== "undefined" && Object.keys(topics).length > 0) {
    topicsString = topics.join(", ");
  }
  return topicsString;
}

/*******************************************************/
/* IndexedDB for more permanent storage of local media */
/*******************************************************/

function getMedia(databaseName, objectStoreName, id) {

  let openRequest = indexedDB.open(databaseName, 1);
  openRequest.onsuccess = function() {
    let db = openRequest.result;
    let transaction = db.transaction(objectStoreName, "readonly");
    let videosStore = transaction.objectStore(objectStoreName);
    let getRequest = videosStore.get(id);

    getRequest.onerror = function() {
      console.error("Error retrieving media:", getRequest.error);
    }

    getRequest.onsuccess = function() {

      const base64String = getRequest.result; // Base64 string

      // no cached media under this key (deleted, or never saved) — leave the
      // player alone rather than setting src to the string "undefined"
      if (base64String === undefined) {
        console.warn("No cached media found for:", id);
        return;
      }

      /* The following commented lines should work (but don't) for a more elegant solution */
      /*const binaryString = atob(base64String.split(',')[1]); // Binary data string
      const blob = new Blob([binaryString], { type: 'audio/mpeg' }); // Create a BLOB object
      let videoURL = URL.createObjectURL(blob);
      document.querySelector("#hyperplayer").src = videoURL;*/

      document.querySelector("#hyperplayer").src = base64String;
    }
  }
}

// Remove an entry's cached media so deleted transcripts don't leave orphaned
// blobs behind (media is stored as base64 data URLs — the dominant quota
// consumer). Deleting an absent key is a harmless no-op.
function deleteMedia(databaseName, objectStoreName, id) {
  if (typeof indexedDB === "undefined" || !id) return;
  let openRequest = indexedDB.open(databaseName, 1);
  openRequest.onupgradeneeded = function() {
    let db = openRequest.result;
    if (!db.objectStoreNames.contains(objectStoreName)) {
      db.createObjectStore(objectStoreName);
    }
  }
  openRequest.onerror = function() {
    console.error("Error opening the database", openRequest.error);
  }
  openRequest.onsuccess = function() {
    let db = openRequest.result;
    let transaction = db.transaction(objectStoreName, "readwrite");
    transaction.objectStore(objectStoreName).delete(id);
  }
}

function saveVideoFromBlobURL(filename, blobData, databaseName, objectStoreName) {

  // Open a connection to IndexedDB
  let openRequest = indexedDB.open(databaseName, 1);

  openRequest.onupgradeneeded = function() {
    let db = openRequest.result;
    if (!db.objectStoreNames.contains(objectStoreName)) {
        db.createObjectStore(objectStoreName);
    }
  }

  openRequest.onerror = function() {
    console.error("Error opening the database", openRequest.error);
  }

  openRequest.onsuccess = function() {
    let db = openRequest.result;

    // Save the video using the provided filename as the key
    let transaction = db.transaction(objectStoreName, "readwrite");
    let videosStore = transaction.objectStore(objectStoreName);
    let request = videosStore.put(blobData, filename);

    request.onerror = function() {
        console.error("Error saving the video", request.error);
    }

    request.onsuccess = function() {
        console.log("Video saved successfully!");
    }
  }
}

function initializeDatabase(database, objectStoreName) {
  return new Promise((resolve, reject) => {
    let openRequest = indexedDB.open(database, 1);

    openRequest.onupgradeneeded = function() {
      let db = openRequest.result;
      if (!db.objectStoreNames.contains(objectStoreName)) {
          db.createObjectStore(objectStoreName);
      }
    }

    openRequest.onerror = function() {
        console.error("Error opening the database", openRequest.error);
        reject(openRequest.error);
    }

    openRequest.onsuccess = function() {
        resolve();
    }
  });
}


/*
 * Save the current HyperTranscript in the local storage.
 *
 * Updates the ACTIVE entry in place when one is loaded (the given name then
 * renames it); otherwise creates a new entry under a fresh ID. Names are
 * de-duplicated with a " (2)" suffix rather than overwriting (#434).
 *
 * @param {string} filename - the display name for the entry
 * @return {void}
 */

function saveHyperTranscriptToLocalStorage(
  filename,
  hypertranscriptDomId = 'hypertranscript',
  videoDomId = 'hyperplayer',
  vttId = 'hyperplayer-vtt',
  storage = window.localStorage
) {
  let hypertranscriptElement = document.getElementById(hypertranscriptDomId);
  let hypertranscript = "";
  if (hypertranscriptElement) {
    hypertranscript = hypertranscriptElement.innerHTML;
  } else {
    //must be in the cache
    hypertranscript = transcriptCache.innerHTML;
  }

  let video = document.getElementById(videoDomId).src;

  // The media reference the interactive-transcript export offers for this doc
  // (#430/#426): a remote src as-is, else the stamped local filename
  // (dataset.mediaRef). A Recents load re-stamps from the saved value, and an
  // older entry may predate this field — fall back to the previous save's.
  const liveMediaRef = /^https?:/i.test(video)
    ? video
    : (document.getElementById(videoDomId).dataset.mediaRef || '');

  // A doc loaded from Recents carries a base64 data: URL as its src (getMedia
  // sets it directly). Never serialise that payload into the localStorage JSON
  // — the media already lives in IndexedDB under meta.mediaKey. Store a marker
  // instead; the load path treats any non-http value the same way (→ getMedia).
  if (video.indexOf("data:") === 0) {
    video = "indexeddb:";
  }

  const existing = activeDocKey !== null ? readTranscriptEntry(activeDocKey, storage) : null;
  const docKey = existing !== null ? activeDocKey : newDocKey();
  const prevMeta = (existing !== null && existing.meta) ? existing.meta : {};
  const desiredName = (typeof filename === "string" && filename.trim() !== "")
    ? filename.trim()
    : (prevMeta.name || "Untitled");
  const now = Date.now();
  const meta = {
    updateCaptionsFromTranscript,
    name: uniqueEntryName(desiredName, storage, docKey),
    mediaKey: prevMeta.mediaKey || docKey,
    created: prevMeta.created || now,
    updated: now,
    starred: prevMeta.starred === true, // meta is rebuilt — carry the star through
    mediaRef: liveMediaRef || prevMeta.mediaRef || undefined, // undefined drops from the JSON
  };

  // if media url begins with blob it means it's locally cached only for the session
  // we need to save the media to indexdb so that we can retrieve outside the session
  // — but only once per document+source: debounced edit autosaves must not
  // re-encode and re-write a large media blob on every pause in typing.

  const mediaStamp = docKey + '|' + video;
  if (video.startsWith("blob:") === true && savedMediaStamp !== mediaStamp) {
    savedMediaStamp = mediaStamp;
    initializeDatabase(MEDIA_DATABASE, MEDIA_STORE)
    .then(() => {
      let blobURL = video;

      fetch(blobURL)
      .then(response => response.blob())
      .then(videoBlob => {
        const reader = new FileReader();
        let blobData = "not defined";
        reader.onloadend = function() {
          blobData = reader.result;
          saveVideoFromBlobURL(meta.mediaKey, blobData, MEDIA_DATABASE, MEDIA_STORE);
        }
        reader.readAsDataURL(videoBlob);
      })
      .catch(error => {
        console.error("Error fetching the video from the blob URL:", error);
      });
    })
    .catch(error => {
      console.error("Error initializing the database:", error);
    });
  }

  let summary = document.getElementById("summary").innerHTML;
  let topics = document.getElementById("topics").innerHTML.split(", ");
  // Only store real caption data (an empty track src would break the load
  // path; captions left undefined make load fall into its regenerate branch).
  let captions = document.getElementById(vttId).src;
  if (typeof captions !== 'string' || captions.indexOf('data:') !== 0) {
    captions = undefined;
  }
  // At auto-add time the track/summary/topics still belong to the PREVIOUS
  // document (see suppressDerivedCapture) — store none of it.
  if (suppressDerivedCapture === true) {
    captions = undefined;
    summary = "";
    topics = [];
  }
  let hypertranscriptstorage = new HyperTranscriptStorage(hypertranscript, video, summary, topics, captions, meta);


  try {
    storage.setItem(docKey, JSON.stringify(hypertranscriptstorage));
    activeDocKey = docKey;
  } catch (error) {
    if (error.name === 'QuotaExceededError') {
        console.error('Storage quota exceeded. Unable to save transcript:', error.message);
        showStorageNotice('Browser storage is full — delete an entry from Recents to make room.');
    } else {
        console.error('Error saving transcript:', error);
    }
  }
}

/*
 * Rename an entry (meta.name only — the storage key and any cached media are
 * untouched). The name is de-duplicated against other entries. `updated` is
 * deliberately NOT bumped: renaming should not reorder the list.
 * @return {boolean} whether the rename was applied
 */
function renameTranscriptEntry(fileKey, newName, storage = window.localStorage) {
  const entry = readTranscriptEntry(fileKey, storage);
  if (entry === null) return false;
  const name = String(newName).trim();
  if (name === "") return false;
  if (name === entryName(fileKey, entry)) return true;
  entry.meta = Object.assign({}, entry.meta, { name: uniqueEntryName(name, storage, fileKey) });
  try {
    storage.setItem(fileKey, JSON.stringify(entry));
  } catch (error) {
    console.error('Error renaming transcript:', error);
    return false;
  }
  return true;
}

// True if any OTHER entry references the same cached media — duplicates share
// their source's mediaKey, so shared media must survive a single delete.
function mediaKeyInUse(mediaKey, excludeKey, storage) {
  if (!mediaKey) return false;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key === excludeKey) continue;
    if (!isDocKey(key) && !isLegacyKey(key)) continue;
    if (entryMediaKey(key, readTranscriptEntry(key, storage)) === mediaKey) return true;
  }
  return false;
}

/*
 * Delete an entry, and its cached media unless another entry (a duplicate)
 * still references it. Works for unparseable legacy entries too (their media
 * key is derived from the legacy name).
 */
function deleteTranscriptEntry(fileKey, storage = window.localStorage) {
  const entry = readTranscriptEntry(fileKey, storage);
  const mediaKey = entryMediaKey(fileKey, entry);
  storage.removeItem(fileKey);
  if (!mediaKeyInUse(mediaKey, fileKey, storage)) {
    deleteMedia(MEDIA_DATABASE, MEDIA_STORE, mediaKey);
  }
  if (activeDocKey === fileKey) {
    activeDocKey = null;
  }
}

/*
 * Duplicate an entry under a fresh ID as "name (2)". The copy shares the
 * original's cached media (deletes are refcounted via mediaKeyInUse) and
 * stamps fresh timestamps, so it appears at the top of the list.
 * @return {string|null} the new entry's key, or null if the source is unusable
 */
function duplicateTranscriptEntry(fileKey, storage = window.localStorage) {
  const entry = readTranscriptEntry(fileKey, storage);
  if (entry === null || typeof entry.hypertranscript !== 'string') return null;
  const now = Date.now();
  const newKey = newDocKey();
  entry.meta = Object.assign({}, entry.meta, {
    name: uniqueEntryName(entryName(fileKey, entry), storage, newKey),
    mediaKey: entryMediaKey(fileKey, entry) || undefined,
    created: now,
    updated: now,
    starred: false, // a copy starts unstarred
  });
  try {
    storage.setItem(newKey, JSON.stringify(entry));
  } catch (error) {
    console.error('Error duplicating transcript:', error);
    if (error.name === 'QuotaExceededError') {
      showStorageNotice('Browser storage is full — delete an entry from Recents to make room.');
    }
    return null;
  }
  return newKey;
}

// Non-blocking notice above the Recents list — replaces the old blocking
// alert(). Error tone auto-dismisses; opts {tone:'info', sticky:true} gives a
// neutral note that stays until its ✕ is clicked (the autosave disclosure).
function showStorageNotice(message, opts = {}) {
  const picker = document.querySelector('#file-picker');
  if (picker === null || picker.parentElement === null) return;
  let el = document.getElementById('recents-notice');
  if (el === null) {
    el = document.createElement('div');
    el.id = 'recents-notice';
    picker.parentElement.insertBefore(el, picker);
  }
  el.setAttribute('role', opts.tone === 'info' ? 'status' : 'alert');
  el.className = opts.tone === 'info' ? 'notice-info' : 'notice-error';
  el.textContent = '';
  el.appendChild(document.createTextNode(message));
  el.dataset.hasAction = opts.action ? 'true' : 'false';
  if (opts.action) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'recents-notice-action';
    action.textContent = opts.action.label;
    action.addEventListener('click', () => { el.remove(); opts.action.handler(); });
    el.appendChild(action);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'recents-notice-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '✕';
  dismiss.addEventListener('click', () => { el.remove(); });
  el.appendChild(dismiss);
  clearTimeout(showStorageNotice._timer);
  if (opts.sticky !== true) {
    showStorageNotice._timer = setTimeout(() => { el.remove(); }, 8000);
  }
}

// A pending Restore offers to re-save the ON-SCREEN document; once the screen
// holds something else (new transcription, another entry loaded) that offer
// would save the wrong content under the old name — withdraw it. Only notices
// carrying an action are removed; the one-time disclosure stays.
function hideRestoreNotice() {
  const el = document.getElementById('recents-notice');
  if (el !== null && el.dataset.hasAction === 'true') el.remove();
}

/* ----------------------------------------------------------------------------
 * Autosave (#435): every new transcription or import lands in Recents
 * automatically, and edits autosave to the active entry.
 *
 * hyperaudioInit is the "a new document just landed" moment — all five
 * transcription engines and the JSON/SRT/VTT import paths dispatch it, and
 * neither the initial demo transcript nor a Recents load does, so listening
 * here can never duplicate an existing entry. The entry is named after its
 * media; edits then autosave debounced to the same entry.
 * ------------------------------------------------------------------------- */

const AUTOSAVE_NOTICE_FLAG = 'hyperaudioAutosaveNoticeShown';
const AUTOSAVE_DEBOUNCE_MS = 2000;

// Display name for the media the player holds: an http(s) src wins (fresh
// remote URL beats a stale stamp — same preference as guessMediaSrc in
// editor-core), then the stamped mediaRef (a local file's real name, or the
// original URL for remote/HLS — #426).
function mediaDisplayName() {
  const player = document.querySelector('#hyperplayer');
  if (player === null) return 'Untitled';
  const ref = (/^https?:/i.test(player.src) ? player.src : player.dataset.mediaRef) || '';
  return mediaNameFromRef(ref);
}

// Pure part of the above: URL → decoded basename of its path; a plain string
// is already a filename; empty → 'Untitled'.
function mediaNameFromRef(ref) {
  if (!ref) return 'Untitled';
  if (/^https?:/i.test(ref)) {
    try {
      const path = new URL(ref).pathname;
      const base = decodeURIComponent(path.substring(path.lastIndexOf('/') + 1));
      return base !== '' ? base : 'Untitled';
    } catch (e) {
      return 'Untitled';
    }
  }
  return ref;
}

// One-time disclosure the first time something autosaves: storage is local to
// this browser/device, and Recents is where to manage it. Informational, not
// a permission gate — shown once ever (flag persists), dismissible.
function maybeShowAutosaveNotice(storage = window.localStorage) {
  try {
    if (storage.getItem(AUTOSAVE_NOTICE_FLAG) !== null) return;
    storage.setItem(AUTOSAVE_NOTICE_FLAG, String(Date.now()));
  } catch (e) {
    return;
  }
  showStorageNotice(
    'Transcripts are saved to Recents automatically — stored in your browser, on this device only.',
    { tone: 'info', sticky: true }
  );
}

let autosaveTimer = null;
let autosavePending = false;

function scheduleAutosave() {
  autosavePending = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(runPendingAutosave, AUTOSAVE_DEBOUNCE_MS);
}

function runPendingAutosave() {
  autosavePending = false;
  // A pending Restore means the on-screen doc was just deleted on purpose —
  // silently recreating it on the next keystroke would fight that; the
  // Restore button is the explicit path back.
  if (document.querySelector('#recents-notice[data-has-action="true"]') !== null) return;

  if (activeDocKey === null) {
    // A never-saved document (the intro demo, or a deleted doc whose Restore
    // offer was dismissed): the first edit brings it into Recents (#436), so
    // "everything you touch is in Recents" holds with no manual save.
    saveHyperTranscriptToLocalStorage(mediaDisplayName());
    maybeShowAutosaveNotice();
  } else {
    const entry = readTranscriptEntry(activeDocKey, window.localStorage);
    saveHyperTranscriptToLocalStorage(entry !== null ? entryName(activeDocKey, entry) : undefined);
  }
  loadLocalStorageOptions(); // reflect the new "updated" order
}

// Run any pending debounced autosave NOW — called before the document is
// replaced (a Recents switch, a new transcription/import, a .hyperaudio
// open). Without this, edits made in the last AUTOSAVE_DEBOUNCE_MS before a
// switch were silently dropped: the timer fired after the swap, against the
// replacing document. Global on purpose: hyperaudio-save.js calls it before
// applying an opened project.
function flushRecentsAutosave() {
  if (!autosavePending) return;
  clearTimeout(autosaveTimer);
  runPendingAutosave();
}

if (typeof document !== 'undefined') {
  // A new transcription/import: always a NEW entry (never overwrite whatever
  // was active before), named after its media.
  window.document.addEventListener('hyperaudioInit', () => {
    flushRecentsAutosave(); // the replaced doc's last edits must land first
    hideRestoreNotice();
    activeDocKey = null;
    suppressDerivedCapture = true;
    try {
      saveHyperTranscriptToLocalStorage(mediaDisplayName());
    } finally {
      suppressDerivedCapture = false;
    }
    loadLocalStorageOptions();
    maybeShowAutosaveNotice();
  }, false);

  // Debounced autosave of edits — transcript (contenteditable) and caption
  // editor inputs both bubble input events.
  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target && target.closest && target.closest('#hypertranscript, #caption-editor') !== null) {
      scheduleAutosave();
    }
  });

  // Kebab menu teardown: outside click, Escape, or any scroll (the fixed menu
  // is anchored to the kebab's on-screen position, which scrolling moves).
  document.addEventListener('click', (event) => {
    if (recentsMenuKey === null) return;
    const t = event.target;
    if (t && t.closest && (t.closest('#recents-menu') !== null || t.closest('.recents-kebab') !== null)) return;
    closeRecentsMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeRecentsMenu();
  });
  document.addEventListener('scroll', () => {
    if (recentsMenuKey !== null) closeRecentsMenu();
  }, true);
}

// Escape text/keys interpolated into picker markup (#410) — a saved filename
// containing < or " must not break (or script) the list.
function escapeStorageMarkup(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const RECENTS_RENAME_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
const RECENTS_DUPLICATE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const RECENTS_KEBAB_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
const RECENTS_STAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const RECENTS_DELETE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

function loadLocalStorageOptions(storage = window.localStorage) {

  migrateLegacyEntries(storage);
  closeRecentsMenu(); // the rows it was anchored to are about to be replaced

  let filePicker = document.querySelector("#file-picker");
  filePicker.innerHTML = "";

  // Entries are referenced by their KEY STRING, never by storage.key(i)
  // position (#410): key order is implementation-defined and shifts whenever
  // ANY key is written — and other modules write keys at arbitrary times
  // (prefs on every toggle) — so a positional index resolved at click time
  // could load a different entry than the one listed.
  const rows = listDocEntries(storage);
  const renderRow = ({ key, name }) => {
    const keyAttr = escapeStorageMarkup(key);
    const nameHtml = escapeStorageMarkup(name);
    filePicker.insertAdjacentHTML("beforeend",
      `<li class="recents-row"><a class="file-item" data-key="${keyAttr}">${nameHtml}</a>` +
      `<span class="recents-actions">` +
      `<button type="button" class="recents-kebab" data-key="${keyAttr}" aria-label="Options for ${nameHtml}" aria-haspopup="menu" aria-expanded="false">${RECENTS_KEBAB_SVG}</button>` +
      `</span></li>`);
  };

  // Starred entries pin above the rest (#440). With nothing starred the panel
  // keeps its static "Recents" h2 and the list looks as it always has; once
  // something is starred that h2 hides and the list carries its own h2-level
  // "Starred" / "Recents" section headings instead (they scroll with the
  // rows). Ordering within each group is unchanged (last edit).
  const starredRows = rows.filter((r) => r.starred);
  const recentRows = rows.filter((r) => !r.starred);
  const panelTitle = document.getElementById('recents-title');
  if (panelTitle !== null) {
    panelTitle.style.display = starredRows.length > 0 ? 'none' : '';
  }
  if (starredRows.length > 0) {
    filePicker.insertAdjacentHTML("beforeend", `<li class="recents-group-heading"><h2>Starred</h2></li>`);
    starredRows.forEach(renderRow);
    if (recentRows.length > 0) {
      filePicker.insertAdjacentHTML("beforeend", `<li class="recents-group-heading"><h2>Recents</h2></li>`);
    }
  }
  recentRows.forEach(renderRow);

  setFileSelectListeners();

  if (rows.length === 0) {
    // opacity 0.75 (not 0.55) so the composited grey still meets the 4.5:1
    // contrast ratio on the white card (#402)
    filePicker.insertAdjacentHTML("beforeend", `<li style="padding:8px 16px; opacity:0.75">No files saved.</li>`);
  }

  markActiveRecentsRow();
}

// Highlight the row of the entry currently loaded in the editor (survives
// re-renders, unlike the click-time class toggle alone).
function markActiveRecentsRow() {
  document.querySelectorAll('#file-picker .file-item').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-key') === activeDocKey);
  });
}

function setFileSelectListeners() {
  let files = document.querySelectorAll('.file-item');

  files.forEach(file => {
    file.removeEventListener('click', fileSelectHandleClick);
    file.addEventListener('click', fileSelectHandleClick);
    file.removeEventListener('mouseover', fileSelectHandleHover);
    file.addEventListener('mouseover', fileSelectHandleHover);
  });

  document.querySelectorAll('.recents-kebab').forEach((btn) => {
    btn.removeEventListener('click', recentsKebabHandleClick);
    btn.addEventListener('click', recentsKebabHandleClick);
  });
}

function fileSelectHandleClick(event) {
  // a rename input lives inside the row's <a>; its clicks are not loads
  if (event.target.classList && event.target.classList.contains('recents-rename-input')) {
    return;
  }
  flushRecentsAutosave(); // the outgoing doc's last edits must land first
  loadHyperTranscriptFromLocalStorage(event.currentTarget.getAttribute("data-key"));

  markActiveRecentsRow();
  event.preventDefault();
  return false;
}

function fileSelectHandleHover(event) {
  loadSummaryFromLocalStorage(event.currentTarget.getAttribute("data-key"), event.currentTarget);
  event.preventDefault();
  return false;
}

/* ---- Recents row actions: rename (inline edit) and delete (two-step) ---- */

function findRecentsItem(fileKey) {
  return [...document.querySelectorAll('#file-picker .file-item')]
    .find((el) => el.getAttribute('data-key') === fileKey) || null;
}

/* ---- Row kebab menu: one shared, fixed-position menu (#436). The list lives
   in a scroll container, so a dropdown positioned inside it would be clipped
   at the card edge for rows near the bottom — a fixed menu anchored to the
   kebab's rect behaves for every row, flipping upward near the viewport
   bottom. Closed by outside click, Escape, any scroll (the anchor moves), or
   a list re-render. ---- */

let recentsMenuKey = null; // storage key the open menu acts on, null when closed

function closeRecentsMenu() {
  const menu = document.getElementById('recents-menu');
  if (menu !== null) menu.remove();
  const kebab = document.querySelector('.recents-kebab[aria-expanded="true"]');
  if (kebab !== null) kebab.setAttribute('aria-expanded', 'false');
  recentsMenuKey = null;
}

function openRecentsMenu(kebabBtn) {
  closeRecentsMenu();
  const fileKey = kebabBtn.getAttribute('data-key');
  recentsMenuKey = fileKey;
  kebabBtn.setAttribute('aria-expanded', 'true');

  const menuEntry = readTranscriptEntry(fileKey, window.localStorage);
  const isStarred = !!(menuEntry && menuEntry.meta && menuEntry.meta.starred === true);

  const menu = document.createElement('div');
  menu.id = 'recents-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML =
    `<button type="button" role="menuitem" class="recents-menu-star">${RECENTS_STAR_SVG}${isStarred ? 'Unstar' : 'Star'}</button>` +
    `<button type="button" role="menuitem" class="recents-menu-rename">${RECENTS_RENAME_SVG}Rename</button>` +
    `<button type="button" role="menuitem" class="recents-menu-duplicate">${RECENTS_DUPLICATE_SVG}Duplicate</button>` +
    `<button type="button" role="menuitem" class="recents-menu-delete">${RECENTS_DELETE_SVG}Delete</button>`;
  document.body.appendChild(menu);

  const anchor = kebabBtn.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, anchor.right - size.width) + 'px';
  menu.style.top = (anchor.bottom + 4 + size.height > window.innerHeight
    ? anchor.top - size.height - 4
    : anchor.bottom + 4) + 'px';

  menu.querySelector('.recents-menu-star').addEventListener('click', () => {
    closeRecentsMenu();
    setTranscriptStarred(fileKey, !isStarred);
    loadLocalStorageOptions();
  });
  menu.querySelector('.recents-menu-rename').addEventListener('click', () => {
    closeRecentsMenu();
    startRecentsRename(fileKey);
  });
  menu.querySelector('.recents-menu-duplicate').addEventListener('click', () => {
    closeRecentsMenu();
    duplicateTranscriptEntry(fileKey);
    loadLocalStorageOptions();
  });
  // two-step delete lives inside the menu: first click arms ("Delete?"), the
  // second executes; closing the menu by any route disarms it
  const del = menu.querySelector('.recents-menu-delete');
  del.addEventListener('click', () => {
    if (del.dataset.confirming !== 'true') {
      del.dataset.confirming = 'true';
      del.classList.add('confirming');
      del.innerHTML = `${RECENTS_DELETE_SVG}Delete?`;
      return;
    }
    closeRecentsMenu();
    performRecentsDelete(fileKey);
  });

  menu.querySelector('.recents-menu-rename').focus();
}

function recentsKebabHandleClick(event) {
  event.preventDefault();
  event.stopPropagation();
  const btn = event.currentTarget;
  if (recentsMenuKey === btn.getAttribute('data-key')) {
    closeRecentsMenu(); // second click on the same kebab toggles it shut
    return;
  }
  openRecentsMenu(btn);
}

// Swap the row label for a text input; Enter/blur commits, Escape cancels.
// Re-rendering the list restores normal rows in every exit path.
function startRecentsRename(fileKey, storage = window.localStorage) {
  const item = findRecentsItem(fileKey);
  if (item === null) return;
  const currentName = entryName(fileKey, readTranscriptEntry(fileKey, storage));

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentName;
  input.className = 'recents-rename-input';
  input.setAttribute('aria-label', 'New name');
  item.textContent = '';
  item.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    if (commit) {
      renameTranscriptEntry(fileKey, input.value, storage);
    }
    loadLocalStorageOptions(storage);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function performRecentsDelete(fileKey) {
  const wasActive = activeDocKey === fileKey;
  const deletedEntry = readTranscriptEntry(fileKey, window.localStorage);
  const name = entryName(fileKey, deletedEntry);
  const wasStarred = !!(deletedEntry && deletedEntry.meta && deletedEntry.meta.starred === true);
  deleteTranscriptEntry(fileKey);
  loadLocalStorageOptions();

  // Deleting the LOADED entry leaves the document on screen (the only undo
  // there is), but autosave stops with it — say so, and offer the undo.
  if (wasActive) {
    showStorageNotice('Removed from Recents. The transcript is still on screen but no longer being saved.', {
      tone: 'info',
      sticky: true,
      action: { label: 'Restore', handler: () => restoreDeletedTranscript(name, wasStarred) },
    });
  }
}

// Undo for deleting the loaded entry: re-save the on-screen document as a
// fresh entry under its old name. Its media blob was deleted with the entry,
// so put the media back too — a data: src (loaded from IndexedDB) is written
// directly; a blob: src re-saves through the normal path (stamp reset).
function restoreDeletedTranscript(name, wasStarred) {
  activeDocKey = null;
  savedMediaStamp = null;
  saveHyperTranscriptToLocalStorage(name);
  if (activeDocKey !== null) {
    if (wasStarred === true) {
      setTranscriptStarred(activeDocKey, true); // the star survives the round trip
    }
    const player = document.querySelector('#hyperplayer');
    if (player !== null && player.src.indexOf('data:') === 0) {
      const entry = readTranscriptEntry(activeDocKey, window.localStorage);
      const mediaKey = entry && entry.meta && entry.meta.mediaKey;
      if (mediaKey) saveVideoFromBlobURL(mediaKey, player.src, MEDIA_DATABASE, MEDIA_STORE);
    }
  }
  loadLocalStorageOptions();
}

// Read an entry by its key string. A corrupted value must not throw out of the
// click handler (that permanently broke the picker), and an entry missing the
// expected fields must not half-populate the editor (renderTranscript reads
// .video and .hypertranscript unguarded) — so parse defensively and validate.
function readTranscriptEntry(fileKey, storage) {
  if (!fileKey) return null;
  try {
    return JSON.parse(storage.getItem(fileKey));
  } catch (e) {
    console.warn(`Could not parse saved transcript "${fileKey}":`, e);
    return null;
  }
}

function loadHyperTranscriptFromLocalStorage(fileKey, storage = window.localStorage){
  let hypertranscriptstorage = readTranscriptEntry(fileKey, storage);

  if (hypertranscriptstorage
      && typeof hypertranscriptstorage.hypertranscript === 'string'
      && typeof hypertranscriptstorage.video === 'string') {

    hideRestoreNotice();
    activeDocKey = fileKey;
    renderTranscript(hypertranscriptstorage, entryMediaKey(fileKey, hypertranscriptstorage));
  } else if (hypertranscriptstorage) {
    console.warn(`Saved entry "${fileKey}" is missing transcript/video fields — not loading.`);
  }
}

// Tooltip preview on hover — only when there is actually something to show.
// Unconditionally setting it gave entries with no summary/topics a stray
// tooltip reading just "Topics:".
function loadSummaryFromLocalStorage(fileKey, target, storage = window.localStorage){

  let hypertranscriptstorage = readTranscriptEntry(fileKey, storage);
  if (hypertranscriptstorage === null) return;

  const summary = typeof hypertranscriptstorage.summary === 'string'
    ? hypertranscriptstorage.summary.trim() : '';
  const topics = getTopicsString(hypertranscriptstorage.topics);
  const parts = [];
  if (summary !== '') parts.push(summary);
  if (topics !== '') parts.push('Topics: ' + topics);

  if (parts.length > 0) {
    target.setAttribute("title", parts.join("\n\n"));
  } else {
    target.removeAttribute("title");
  }
}

// Export pure helpers for the unit lane (#434); the file only declares
// functions at load time, so requiring it in Node is safe (deleteMedia guards
// on indexedDB being present).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isDocKey,
    isLegacyKey,
    entryName,
    entryMediaKey,
    uniqueEntryName,
    listDocEntries,
    migrateLegacyEntries,
    renameTranscriptEntry,
    deleteTranscriptEntry,
    duplicateTranscriptEntry,
    setTranscriptStarred,
    mediaKeyInUse,
    readTranscriptEntry,
    escapeStorageMarkup,
    mediaNameFromRef,
  };
}

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
    });
  }
  rows.sort((a, b) => (b.updated - a.updated) || a.name.localeCompare(b.name));
  return rows;
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

  // Drop any media reference stamped by a previous local/remote load so the
  // interactive-transcript export can't offer it for this Recents entry (a remote
  // http src is read from the player directly; a local one falls back to empty).
  const loadedVideo = document.getElementById(videoDomId);
  if (loadedVideo) delete loadedVideo.dataset.mediaRef;

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
    //load from indexedDB
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

// Prefill for the save dialog: the active entry's name if one is loaded,
// otherwise the media filename.
function getLocalStorageSaveFilename(url){
  if (activeDocKey !== null) {
    const entry = readTranscriptEntry(activeDocKey, window.localStorage);
    if (entry !== null) {
      return entryName(activeDocKey, entry);
    }
  }
  return url.substring(url.lastIndexOf("/") + 1);
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
  };

  // if media url begins with blob it means it's locally cached only for the session
  // we need to save the media to indexdb so that we can retrieve outside the session

  if (video.startsWith("blob:") === true) {
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
  let captions = document.getElementById(vttId).src;
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

/*
 * Delete an entry and its cached media. Works for unparseable legacy entries
 * too (their media key is derived from the legacy name).
 */
function deleteTranscriptEntry(fileKey, storage = window.localStorage) {
  const entry = readTranscriptEntry(fileKey, storage);
  const mediaKey = entryMediaKey(fileKey, entry);
  storage.removeItem(fileKey);
  deleteMedia(MEDIA_DATABASE, MEDIA_STORE, mediaKey);
  if (activeDocKey === fileKey) {
    activeDocKey = null;
  }
}

// Non-blocking notice above the Recents list (quota problems etc.) — replaces
// the old blocking alert(). Auto-dismisses.
function showStorageNotice(message) {
  const picker = document.querySelector('#file-picker');
  if (picker === null || picker.parentElement === null) return;
  let el = document.getElementById('recents-notice');
  if (el === null) {
    el = document.createElement('div');
    el.id = 'recents-notice';
    el.setAttribute('role', 'alert');
    picker.parentElement.insertBefore(el, picker);
  }
  el.textContent = message;
  clearTimeout(showStorageNotice._timer);
  showStorageNotice._timer = setTimeout(() => { el.remove(); }, 8000);
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
const RECENTS_DELETE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

function loadLocalStorageOptions(storage = window.localStorage) {

  migrateLegacyEntries(storage);

  let fileSelect = document.querySelector("#load-localstorage-filename");
  let filePicker = document.querySelector("#file-picker");

  fileSelect.innerHTML = '<option value="default">Select file…</option>';
  filePicker.innerHTML = "";

  // Entries are referenced by their KEY STRING, never by storage.key(i)
  // position (#410): key order is implementation-defined and shifts whenever
  // ANY key is written — and other modules write keys at arbitrary times
  // (prefs on every toggle) — so a positional index resolved at click time
  // could load a different entry than the one listed.
  const rows = listDocEntries(storage);
  rows.forEach(({ key, name }) => {
    const keyAttr = escapeStorageMarkup(key);
    const nameHtml = escapeStorageMarkup(name);
    fileSelect.insertAdjacentHTML("beforeend", `<option value="${keyAttr}">${nameHtml}</option>`);
    filePicker.insertAdjacentHTML("beforeend",
      `<li class="recents-row"><a class="file-item" title="..." data-key="${keyAttr}">${nameHtml}</a>` +
      `<span class="recents-actions">` +
      `<button type="button" class="recents-rename" data-key="${keyAttr}" aria-label="Rename ${nameHtml}" title="Rename">${RECENTS_RENAME_SVG}</button>` +
      `<button type="button" class="recents-delete" data-key="${keyAttr}" aria-label="Delete ${nameHtml}" title="Delete">${RECENTS_DELETE_SVG}</button>` +
      `</span></li>`);
  });

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

  document.querySelectorAll('.recents-rename').forEach((btn) => {
    btn.removeEventListener('click', recentsRenameHandleClick);
    btn.addEventListener('click', recentsRenameHandleClick);
  });

  document.querySelectorAll('.recents-delete').forEach((btn) => {
    btn.removeEventListener('click', recentsDeleteHandleClick);
    btn.addEventListener('click', recentsDeleteHandleClick);
  });
}

function fileSelectHandleClick(event) {
  // a rename input lives inside the row's <a>; its clicks are not loads
  if (event.target.classList && event.target.classList.contains('recents-rename-input')) {
    return;
  }
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

function recentsRenameHandleClick(event) {
  event.preventDefault();
  event.stopPropagation();
  startRecentsRename(event.currentTarget.getAttribute('data-key'));
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
      if (activeDocKey === fileKey) {
        const saveInput = document.querySelector('#save-localstorage-filename');
        if (saveInput !== null) {
          saveInput.value = entryName(fileKey, readTranscriptEntry(fileKey, storage));
        }
      }
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

// First click arms the button ("Delete?"), second click within the window
// deletes; the timeout restores the button without re-rendering the list (a
// re-render could interrupt a rename in progress on another row).
function recentsDeleteHandleClick(event) {
  event.preventDefault();
  event.stopPropagation();
  const btn = event.currentTarget;

  if (btn.dataset.confirming !== 'true') {
    btn.dataset.confirming = 'true';
    btn.classList.add('confirming');
    btn.textContent = 'Delete?';
    btn._resetTimer = setTimeout(() => {
      btn.dataset.confirming = 'false';
      btn.classList.remove('confirming');
      btn.innerHTML = RECENTS_DELETE_SVG;
    }, 4000);
    return;
  }

  clearTimeout(btn._resetTimer);
  deleteTranscriptEntry(btn.getAttribute('data-key'));
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

    activeDocKey = fileKey;
    renderTranscript(hypertranscriptstorage, entryMediaKey(fileKey, hypertranscriptstorage));

    document.querySelector('#save-localstorage-filename').value = entryName(fileKey, hypertranscriptstorage);
  } else if (hypertranscriptstorage) {
    console.warn(`Saved entry "${fileKey}" is missing transcript/video fields — not loading.`);
  }
}

function loadSummaryFromLocalStorage(fileKey, target, storage = window.localStorage){

  let hypertranscriptstorage = readTranscriptEntry(fileKey, storage);

  if (hypertranscriptstorage && hypertranscriptstorage.summary !== undefined) {
    target.setAttribute("title", hypertranscriptstorage.summary + "\n\nTopics: " + getTopicsString(hypertranscriptstorage.topics));
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
    readTranscriptEntry,
    escapeStorageMarkup,
  };
}

/*
 * HyperTranscriptStorage class
 * @param {string} hypertranscript - the html of the hypertranscript
 * @param {string} video - the html of the video
 * @return {void}
 */
class HyperTranscriptStorage {
  constructor(hypertranscript, video) {
    this.hypertranscript = hypertranscript;
    this.video = video;
  }
}

// We should move these from global scope
const fileExtension = ".hyperaudio";
let lastFilename = null;

/*
 * Render the HyperTranscript in the DOM
 * @return {void}
 */
function renderTranscript(
  hypertranscriptstorage,
  hypertranscriptDomId = 'hypertranscript',
  videoDomId = 'hyperplayer'
) {
  document.getElementById(hypertranscriptDomId).innerHTML = hypertranscriptstorage['hypertranscript'];
  document.getElementById(videoDomId).src = hypertranscriptstorage['video'];

  hyperaudio();
}

function getLocalStorageSaveFilename(url){
  let filename = null;

  if (lastFilename === null) {
    //by default just the media filename
    filename = url.substring(url.lastIndexOf("/")+1);
    lastFilename = filename;
  } else {
    // if it's been saved before this session, use the last filename
    filename = lastFilename;
  }

  return filename;
}

/*
 * Save the current HyperTranscript in the local storage
 * @param {string} filename - the name of the transcript file
 * @param {string} hypertranscriptDomId - the id of the hypertranscript dom element
 * @param {string} videoDomId - the id of the video dom element
 * @return {void}
 */

function saveHyperTranscriptToLocalStorage(
  filename,
  hypertranscriptDomId = 'hypertranscript',
  videoDomId = 'hyperplayer',
  storage = window.localStorage
) {
  console.log("saving");
  let hypertranscript = document.getElementById(hypertranscriptDomId).innerHTML;
  let video = document.getElementById(videoDomId).src;
  let hypertranscriptstorage = new HyperTranscriptStorage(hypertranscript, video);

  storage.setItem(filename+fileExtension, JSON.stringify(hypertranscriptstorage));
}

function loadLocalStorageOptions(storage = window.localStorage) {

  let fileSelect = document.querySelector("#load-localstorage-filename");
  let filePicker = document.querySelector("#file-picker");
  
  fileSelect.innerHTML = '<option value="default">Select file…</option>';
  filePicker.innerHTML = "";
  
  for (let i = 0; i < storage.length; i++) {
    if (storage.key(i).indexOf(fileExtension) > 0) {
      let filename = storage.key(i).substring(0,storage.key(i).lastIndexOf(fileExtension));
      fileSelect.insertAdjacentHTML("beforeend", `<option value=${i}>${filename}</option>`);
      filePicker.insertAdjacentHTML("beforeend", `<li><a class="file-item" href=${i}>${filename}</a></li>`);
    }
  }
}

function loadHyperTranscriptFromLocalStorage(fileindex, storage = window.localStorage){
  let hypertranscriptstorage = JSON.parse(storage.getItem(storage.key(fileindex)));
  if (hypertranscriptstorage) {
    renderTranscript(hypertranscriptstorage);
    lastFilename = storage.key(fileindex).substring(0,storage.key(fileindex).lastIndexOf(fileExtension));
    document.querySelector('#save-localstorage-filename').value = lastFilename;
  }
}




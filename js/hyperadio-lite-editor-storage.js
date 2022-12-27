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


/**
 * Abstract Class Storage.
 *
 * @class Storage
 */
 class Storage {

  constructor() {
    if (this.constructor == Storage) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  getItem(key) {
    throw new Error("Method 'getItem()' must be implemented.");
  }

  length() {
    throw new Error("Method 'length()' must be implemented.");
  }

  key(index) {
    throw new Error("Method 'key()' must be implemented.");
  }
}

/*
 * Render the HyperTranscript in the DOM
 * @return {void}
 */
function renderTranscript(
  hypertranscriptstorage,
  hypertranscriptDomId = 'hypertranscript',
  videoDomId = 'hyperplayer',
) {
  document.getElementById(hypertranscriptDomId).innerHTML = hypertranscriptstorage['hypertranscript'];
  document.getElementById(videoDomId).src = hypertranscriptstorage['video'];
}

/*
 * Save the current HyperTranscript in the local storage
 * @param {string} transcriptionName - the name of the transcription
 * @param {string} hypertranscriptDomId - the id of the hypertranscript dom element
 * @param {string} videoDomId - the id of the video dom element
 * @return {void}
 */
function saveHyperTranscript(
  transcriptionName = 'hypertranscript--last',
  hypertranscriptDomId = 'hypertranscript',
  videoDomId = 'hyperplayer',
  storage = localStorage,
) {
  let hypertranscript = document.getElementById(hypertranscriptDomId).innerHTML;
  let video = document.getElementById(videoDomId).src;
  let hypertranscriptstorage = new HyperTranscriptStorage(hypertranscript, video);
  storage.setItem(transcriptionName, JSON.stringify(hypertranscriptstorage));
  console.log('HyperTranscript saved');
}

/*
 * Load the current HyperTranscript in the local storage
 * @param {string} transcriptionName - the name of the transcription
 * @param {string} hypertranscriptDomId - the id of the hypertranscript dom element
 * @param {string} videoDomId - the id of the video dom element
 * @return {void}
 */
function loadHyperTranscript(
  transcriptionName = 'hypertranscript--last',
  hypertranscriptDomId = 'hypertranscript',
  videoDomId = 'hyperplayer',
  storage=localStorage,
) {
  let hypertranscriptstorage = JSON.parse(storage.getItem(transcriptionName));
  if (hypertranscriptstorage) {
    renderTranscript(hypertranscriptstorage);
    console.log('HyperTranscript loaded');
  } else {
    alert('no saved HyperTranscript found');
  }
}

/*
 * Select the HyperTranscript in the local storage to display
 */
function selectLoadHyperTranscript(storage=localStorage) {
  let hypertranscriptSavedUrls = '';
  for (let i = 0; i < storage.length; i++) {
    hypertranscriptSavedUrls += `\n ${i} - ${storage.key(i)}`;
  }
  hypertranscriptSavedUrls += '';
  console.log(hypertranscriptSavedUrls);

  let transcriptionNameKey = prompt(`Enter the number of the saved HyperTranscript: ${hypertranscriptSavedUrls}`);
  let hypertranscriptstorage = JSON.parse(storage.getItem(storage.key(transcriptionNameKey)));
  if (hypertranscriptstorage) {
    renderTranscript(hypertranscriptstorage);
    console.log('HyperTranscript loaded');
  } else {
    alert('no saved HyperTranscript found');
  }
}

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
/*
 * Save the current HyperTranscript in the local storage
 * @param {string} transcriptionName - the name of the transcription
 * @param {string} hypertranscriptDomId - the id of the hypertranscript dom element
 * @param {string} videoDomId - the id of the video dom element
 * @return {void}
 */
function renderTranscript(
  hypertranscriptstorage,
  hypertranscriptDomId = 'hypertranscript',
  videoDomId = 'hyperplayer',
) {
  document.getElementById(hypertranscriptDomId).innerHTML = hypertranscriptstorage['hypertranscript'];
  document.getElementById(videoDomId).outerHTML = hypertranscriptstorage['video'];
}

function saveHyperTranscript(
  transcriptionName = 'hypertranscript--last',
  hypertranscriptDomId = 'hypertranscript',
  videoDomId = 'hyperplayer',
) {
  let hypertranscript = document.getElementById(hypertranscriptDomId).innerHTML;
  let video = document.getElementById(videoDomId).outerHTML;
  let hypertranscriptstorage = new HyperTranscriptStorage(hypertranscript, video);
  localStorage.setItem(transcriptionName, JSON.stringify(hypertranscriptstorage));
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
) {
  let hypertranscriptstorage = JSON.parse(localStorage.getItem(transcriptionName));
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
function selectLoadHyperTranscript() {
  let hypertranscriptSavedUrls = '';
  for (let i = 0; i < localStorage.length; i++) {
    hypertranscriptSavedUrls += `\n ${i} - ${localStorage.key(i)}`;
  }
  hypertranscriptSavedUrls += '';
  console.log(hypertranscriptSavedUrls);

  let transcriptionNameKey = prompt(`Enter the number of the saved HyperTranscript: ${hypertranscriptSavedUrls}`);
  let hypertranscriptstorage = JSON.parse(localStorage.getItem(localStorage.key(transcriptionNameKey)));
  if (hypertranscriptstorage) {
    renderTranscript(hypertranscriptstorage);
    console.log('HyperTranscript loaded');
  } else {
    alert('no saved HyperTranscript found');
  }
}

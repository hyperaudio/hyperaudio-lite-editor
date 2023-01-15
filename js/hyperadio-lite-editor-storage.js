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
const fileExtension = '.hyperaudio';
let lastFilename = null;

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

  hyperaudio();
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
  storage = window.localStorage,
) {
  let hypertranscript = document.getElementById(hypertranscriptDomId).innerHTML;
  let video = document.getElementById(videoDomId).src;
  let hypertranscriptstorage = new HyperTranscriptStorage(hypertranscript, video);

  const fileSaveDialog = document.querySelector('#fileSaveDialog');
  fileSaveDialog.showModal();

  let filenameSave = document.querySelector('#localstorage-fname');

  //TODO – store .hyperaudio in a const named localStorageExtension or similar

  if (lastFilename === null) {
    //by default just the media filename
    filenameSave.value = transcriptionName
      .substring(0, transcriptionName.lastIndexOf(fileExtension))
      .substring(transcriptionName.lastIndexOf('/') + 1);
    lastFilename = filenameSave.value;
  } else {
    // if it's been saved before this session, use the last filename
    filenameSave.value = lastFilename;
  }

  fileSaveDialog.addEventListener('close', () => {
    storage.setItem(filenameSave.value + fileExtension, JSON.stringify(hypertranscriptstorage));
    console.log('HyperTranscript saved');
  });
}

/*
 * Select the HyperTranscript saved in the localStorage to display
 */
function selectLoadHyperTranscript(storage = window.localStorage) {
  const fileSelectDialog = document.querySelector('#fileSelectDialog');
  const confirmBtn = fileSelectDialog.querySelector('#confirmBtn');

  fileSelectDialog.showModal();

  let fileSelect = document.querySelector('#localstorage-select');
  let hypertranscriptSavedUrls = '';
  fileSelect.innerHTML = '<option value="default">Select file…</option>';
  for (let i = 0; i < storage.length; i++) {
    if (storage.key(i).indexOf(fileExtension) > 0) {
      hypertranscriptSavedUrls += `\n ${i} - ${storage.key(i)}`;
      let filename = storage.key(i).substring(0, storage.key(i).lastIndexOf(fileExtension));
      fileSelect.insertAdjacentHTML('beforeend', `<option value=${i}>${filename}</option>`);
    }
  }

  fileSelect.addEventListener('change', () => {
    confirmBtn.value = document.querySelector('#localstorage-select').value;
    lastFilename =
      document.querySelector('#localstorage-select').options[
        document.querySelector('#localstorage-select').selectedIndex
      ].innerHTML;
  });

  fileSelectDialog.addEventListener('close', () => {
    if (fileSelectDialog.returnValue !== 'cancel') {
      let hypertranscriptstorage = JSON.parse(storage.getItem(storage.key(fileSelectDialog.returnValue)));
      if (hypertranscriptstorage) {
        renderTranscript(hypertranscriptstorage);
        console.log('HyperTranscript loaded');
      } else {
        alert('no saved HyperTranscript found');
      }
    }
  });
}

function exportHyperTranscript() {
  function downloadJson(data, filename) {
    let json = JSON.stringify(data);
    let blob = new Blob([json], { type: 'application/json' });
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  let data = {};
  for (let i = 0; i < localStorage.length; i++) {
    let key = localStorage.key(i);
    if (key.endsWith(fileExtension)) {
      data[key] = localStorage.getItem(key);
    }
  }
  downloadJson(data, 'localstorage.hyperaudio.json');
}


function importHyperTranscript(file) {
  let reader = new FileReader();
  reader.onload = function () {
  let data
    try {
      data = JSON.parse(reader.result);
    }
    catch (e) {
      // error is not a valid JSON
      alert(`It is not a valid hyperaudio.json file: ${e.name}: ${e.message}`);
      return;
    }

    //hypertranscriptKey check if there are any hyperaudio data in the json file
    let hypertranscriptKey = 0;
    for (let key in data) {
      if (key.endsWith(fileExtension)) {
        localStorage.setItem(key, data[key]);
        hypertranscriptKey = hypertranscriptKey + 1;
        
        }
      }
    if (hypertranscriptKey === 0) {
    alert('No hyperaudio data found in the selected file');
    }
  };
  
  reader.readAsText(file);
  

}




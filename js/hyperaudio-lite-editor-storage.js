/*
 * HyperTranscriptStorage class
 * @param {string} hypertranscript - the html of the hypertranscript
 * @param {string} video - the url of the video
 * @param {string} summary - the text of the summary
 * @param {array} topics - an array of topics
 * @param {string} captions - VTT format
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
  videoDomId = 'hyperplayer',
  vttId = 'hyperplayer-vtt'
) {
  document.getElementById(hypertranscriptDomId).innerHTML = hypertranscriptstorage['hypertranscript'];
  document.getElementById(videoDomId).src = hypertranscriptstorage['video'];
  document.getElementById("summary").innerHTML = hypertranscriptstorage['summary'];
  document.getElementById("topics").innerHTML = getTopicsString(hypertranscriptstorage['topics']);

  // backward compatibility – check that captions exist, if not generate

  if (hypertranscriptstorage['captions'] === undefined) { //backward compatibility for transcripts without captions
    const capEvent = new CustomEvent('hyperaudioGenerateCaptionsFromTranscript');
    document.dispatchEvent(capEvent);
  } else {
    // stop caption.js inserting VTT upon insertion of new video

    document.getElementById(vttId).src = hypertranscriptstorage['captions'];
    //remove data:text/vtt, and decode
    let plainVtt = decodeURIComponent(hypertranscriptstorage['captions'].split(',')[1]);

    if (hypertranscriptstorage['meta'] !== undefined && hypertranscriptstorage['meta'].updateCaptionsFromTranscript !== undefined) {
      updateCaptionsFromTranscript = hypertranscriptstorage['meta'].updateCaptionsFromTranscript;
    } else {
      updateCaptionsFromTranscript = true;
    }
    
    populateCaptionEditorFromVtt(plainVtt);
  }

  let hypertranscript = document.querySelector("#hypertranscript").innerHTML.replace(/ class=".*?"/g, '');
  document.querySelector('#download-html').setAttribute('href', 'data:text/html,'+encodeURIComponent(hypertranscript));

  const itDownloadEvent = new CustomEvent('hyperaudioUpdateInteractiveTranscriptDownloadLink');
  document.dispatchEvent(itDownloadEvent);
  
  //maybe better called using hyperaudioInit event?
  //hyperaudio();
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

function getTopicsString(topics) {
  let topicsString = "";
  if (topics && topics !== "undefined" && Object.keys(topics).length > 0) {
    topicsString = topics.join(", ");
  }
  return topicsString;
}


/* IndexedDB for more permanent storage of local media */

function saveVideoFromBlobURL(filename, blobData) {
  
  // Open a connection to IndexedDB
  let openRequest = indexedDB.open("hyperaudioMedia", 1);

  openRequest.onupgradeneeded = function() {
    let db = openRequest.result;
    if (!db.objectStoreNames.contains("media")) {
        db.createObjectStore("media");
    }
  };

  openRequest.onerror = function() {
    console.error("Error opening the database", openRequest.error);
  };

  openRequest.onsuccess = function() {
    let db = openRequest.result;

    // Save the video using the provided filename as the key
    let transaction = db.transaction("media", "readwrite");
    let videosStore = transaction.objectStore("media");
    //let request = videosStore.put(videoBlob, filename);
    let request = videosStore.put(blobData, filename);

    request.onerror = function() {
        console.error("Error saving the video", request.error);
    };

    request.onsuccess = function() {
        console.log("Video saved successfully!");
    };
  };    
}

function initializeDatabase() {
  return new Promise((resolve, reject) => {
      let openRequest = indexedDB.open("hyperaudioMedia", 1);

      console.log("initialising the database...");

      openRequest.onupgradeneeded = function() {
          console.log("openRequest.onupgradeneeded");
          let db = openRequest.result;
          if (!db.objectStoreNames.contains("media")) {
              console.log("creating media objectstore");
              db.createObjectStore("media");
          }
      };

      openRequest.onerror = function() {
          console.error("Error opening the database", openRequest.error);
          reject(openRequest.error);
      };

      openRequest.onsuccess = function() {
          resolve();
      };
  });
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
  vttId = 'hyperplayer-vtt',
  storage = window.localStorage
) {
  let hypertranscript = document.getElementById(hypertranscriptDomId).innerHTML;
  let video = document.getElementById(videoDomId).src;

  console.log("========== video url =========");
  console.log(video);

  // if media url begins with blob it means it's locally cached only for the session
  // we need to save the media to indexdb so that we can retrieve outside the session

  if (video.startsWith("blob:") === true) {
    initializeDatabase()
    .then(() => {
      let blobURL = video;

      fetch(blobURL)
        .then(response => response.blob())
        .then(videoBlob => {
          const reader = new FileReader();
          let blobData = "not defined";
          reader.onloadend = function() {
            console.log("blob contents");
            console.log(reader.result); // Questo mostrerà il contenuto del blob come base64
            blobData = reader.result;
            saveVideoFromBlobURL(filename, blobData);
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
  let meta = {"updateCaptionsFromTranscript": updateCaptionsFromTranscript};
  let hypertranscriptstorage = new HyperTranscriptStorage(hypertranscript, video, summary, topics, captions, meta);

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
      filePicker.insertAdjacentHTML("beforeend", `<li><a class="file-item" title="..." data-index=${i}>${filename}</a></li>`);
    }
  }

  setFileSelectListeners();

  if (storage.length === 0) {
    filePicker.insertAdjacentHTML("beforeend", `<li style="padding-left:16px; padding-top:16px">No files saved.</li>`);
  }
}

function setFileSelectListeners() {
  let files = document.querySelectorAll('.file-item');

  files.forEach(file => {
    file.removeEventListener('click', fileSelectHandleClick);
    file.addEventListener('click', fileSelectHandleClick);
    file.removeEventListener('mouseover', fileSelectHandleHover);
    file.addEventListener('mouseover', fileSelectHandleHover);
  });
}

function fileSelectHandleClick(event) {
  loadHyperTranscriptFromLocalStorage(event.target.getAttribute("data-index"));

  let files = document.querySelectorAll('.file-item');

  files.forEach(file => {
    file.classList.remove("active");
  });

  event.target.classList.add("active");
  event.preventDefault();
  return false;
}

function fileSelectHandleHover(event) {
  loadSummaryFromLocalStorage(event.target.getAttribute("data-index"), event.target);
  event.preventDefault();
  return false;
}

function loadHyperTranscriptFromLocalStorage(fileindex, storage = window.localStorage){
  let hypertranscriptstorage = JSON.parse(storage.getItem(storage.key(fileindex)));

  if (hypertranscriptstorage) {
    /*if (hypertranscriptstorage("video").startsWith(":blob") === true) {
      
      
    } else {

    }*/


    console.log("------- hypertranscriptstorage ---------");
    console.dir(hypertranscriptstorage);


    renderTranscript(hypertranscriptstorage);
    lastFilename = storage.key(fileindex).substring(0,storage.key(fileindex).lastIndexOf(fileExtension));
    document.querySelector('#save-localstorage-filename').value = lastFilename;
  }
}

function loadSummaryFromLocalStorage(fileindex, target, storage = window.localStorage){
  
  let hypertranscriptstorage = JSON.parse(storage.getItem(storage.key(fileindex)));

  if (hypertranscriptstorage) {
    target.setAttribute("title", hypertranscriptstorage.summary + "\n\nTopics: " + getTopicsString(hypertranscriptstorage.topics)); 
  }
}
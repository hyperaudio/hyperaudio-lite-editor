/* Extracted verbatim from index.html (#334) — loaded as a classic script in the same document order. */

  document.querySelector('#file-dropdown').insertAdjacentHTML("beforeend", '<hr class="my-2 h-0 border border-t-0 border-solid border-neutral-700 opacity-25 dark:border-neutral-200" /><li class="menu-title"><span>Local Storage</span></li><li><label for="file-save-dialog">Save to Local Storage</label></li><li><label for="file-load-dialog">Load from Local Storage</label></li>');

  document.querySelector('#save-localstorage-filename').value = getLocalStorageSaveFilename(document.querySelector("#hyperplayer").src);

  loadLocalStorageOptions();

  document
    .querySelector("#file-save-localstorage")
    .addEventListener("click", function () {
      let filename = document.querySelector('#save-localstorage-filename').value;
      saveHyperTranscriptToLocalStorage(filename);
      loadLocalStorageOptions();
    });

  document
    .querySelector("#file-load-localstorage")
    .addEventListener("click", function () {
      let filenameIndex = document.querySelector('#load-localstorage-filename').value;
      loadHyperTranscriptFromLocalStorage(filenameIndex);
    });

  document
    .querySelector("#regenerate-captions")
    .addEventListener("click", function () {
      captionCache = null;
      hyperaudioGenerateCaptionsFromTranscript();
    });

  setFileSelectListeners();


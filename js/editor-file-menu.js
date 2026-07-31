/* Extracted verbatim from index.html (#334) — loaded as a classic script in the same document order. */

  // The FILE menu's Save/Load Local Storage dialogs are gone (#436): Recents
  // autosaves everything (#435), rows rename/duplicate/delete inline (#434),
  // and deleting the loaded entry offers Restore — so the dialogs had no
  // remaining job. This just renders the initial Recents list.
  loadLocalStorageOptions();

  document
    .querySelector("#regenerate-captions")
    .addEventListener("click", function () {
      captionCache = null;
      hyperaudioGenerateCaptionsFromTranscript();
    });

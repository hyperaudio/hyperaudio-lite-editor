/* Extracted verbatim from index.html (#334) — loaded as a classic script in the same document order. */

  // The legacy Local Storage flows are gone (#451): projects live as
  // .hyperaudio files (Save button / Import Project). Only the caption
  // regeneration wiring remains — it was never persistence.
  document
    .querySelector("#regenerate-captions")
    .addEventListener("click", function () {
      captionCache = null;
      hyperaudioGenerateCaptionsFromTranscript();
    });

/* Extracted verbatim from index.html (#334) — loaded as a classic script in the same document order. */

  // The legacy Local Storage flows are gone (#451): projects live as
  // .hyperaudio files (Save button / Import Project). Only the caption
  // regeneration wiring remains — it was never persistence.
  document
    .querySelector("#regenerate-captions")
    .addEventListener("click", function () {
      captionCache = null;
      // Regenerating IS choosing transcript-derived captions: sync resumes
      // until the next hand edit flips it off again. Before this, regenerated
      // captions stayed marked "curated" and stopped following the transcript
      // — a one-shot rebuild rather than the re-subscription the button's own
      // confirm dialog implies.
      updateCaptionsFromTranscript = true;
      hyperaudioGenerateCaptionsFromTranscript();
    });

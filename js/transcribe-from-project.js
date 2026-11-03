/**
 * transcribe-from-project.js
 * (C) The Hyperaudio Project
 * @version 1.3.43 — last changed in release 1.3.43
 * @license MIT
 *
 * Retranscribe, from a Recents row (#677): opens the project, then the
 * Transcribe dialog with that project's media already chosen, so the user
 * picks the engine, model and language as usual and presses Transcribe.
 * Nothing runs without that step. The result replaces the project's
 * transcript: the project library is told which project the next
 * transcription is for (HyperaudioSave.library.retranscribe), and it writes
 * the result into that project instead of a new one, on screen or in the
 * background, with the project's title and media kept. The engines are not
 * involved. Closing the dialog without transcribing undoes the arrangement,
 * and the project is simply left open.
 *
 * The media goes into every engine's own input, because each engine reads
 * its own at submit: the five file inputs for a file the project holds
 * (`kind: original`), the five URL fields for a project that plays from a
 * link (`kind: link`). The change event on a file input is what the rest of
 * the editor listens for: the project library learns the media file from it
 * (hyperaudio-save.js, wireCapture), the engines enable their submit button
 * and the cloud engines clear their URL field. The input and change events
 * on a URL field do the same for a link. An engine added later joins the two
 * lists here, as docs/adding-an-stt-engine.md says.
 *
 * Exposed as window.hyperaudioTranscribeFromProject(id), which resolves to
 * null when the dialog is open, or to a reason it is not, for the caller to
 * show. Remove this file and the menu item does nothing more than say so.
 */
(function () {
  'use strict';

  const FILE_INPUTS = ['#file-input', '#parakeet-file-input', '#deepgram-file', '#assemblyai-file', '#parakeet-hf-file'];
  const URL_INPUTS = ['#media', '#parakeet-media', '#deepgram-media', '#assemblyai-media', '#parakeet-hf-media'];

  function fileInputs(file) {
    FILE_INPUTS.forEach((selector) => {
      const input = document.querySelector(selector);
      if (input === null) return;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function urlInputs(url) {
    // the link takes the place of any file: a file input with a file wins at
    // submit in every engine, and only the cloud engines clear theirs on a
    // URL change
    FILE_INPUTS.forEach((selector) => {
      const input = document.querySelector(selector);
      if (input !== null) input.value = '';
    });
    URL_INPUTS.forEach((selector) => {
      const input = document.querySelector(selector);
      if (input === null) return;
      input.value = url;
      const details = input.closest('details.url-source');
      if (details !== null) details.open = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  async function transcribeFromProject(id) {
    const save = window.HyperaudioSave;
    if (!save || !save.library || typeof save.library.open !== 'function') {
      return 'The project library is not available here.';
    }
    if (document.documentElement.classList.contains('ha-transcribing')) {
      return 'A transcription is already running. Wait for it to finish, then try again.';
    }
    // the project first, so the player and the session already belong to the
    // media being transcribed, and closing the dialog leaves them consistent
    const opened = await save.library.open(id);
    if (opened === false) return 'The project could not be opened.';
    const state = typeof save.captureState === 'function' ? save.captureState() : null;
    const media = state && state.media ? state.media : { kind: 'none' };
    if (media.kind === 'none') return 'This project has no media to transcribe.';
    // the next transcription is this project's: armed after the open, which
    // disarms whatever was armed before
    if (typeof save.library.retranscribe !== 'function' || (await save.library.retranscribe(id)) !== true) {
      return 'The project could not be set up to be transcribed again.';
    }
    if (media.kind === 'link' && media.url) {
      urlInputs(media.url);
    } else {
      const file = typeof save.sessionMediaFile === 'function' ? save.sessionMediaFile() : null;
      if (!(file instanceof File) || file.size === 0) {
        return 'The project’s media file could not be read, so there is nothing to transcribe.';
      }
      fileInputs(file);
    }
    // on a phone the library is a drawer over the page: out of the way first
    const backdrop = document.getElementById('drawer-backdrop');
    if (backdrop !== null && document.body.classList.contains('drawer-open')) backdrop.click();
    const modal = document.getElementById('transcribe-modal');
    if (modal === null) return 'The Transcribe dialog is not on this page.';
    modal.checked = true;
    return null;
  }

  window.hyperaudioTranscribeFromProject = transcribeFromProject;
})();

/**
 * corrected-text.js
 * (C) The Hyperaudio Project
 * @version 1.3.55 — last changed in release 1.3.55
 * @license AGPL-3.0-only
 *
 * Corrected text (#845): a project's words replaced by corrected ones, each
 * keeping the time of the word it matches. Reached from a project's ⋮ menu
 * in Recents, which opens that project first, and from File ▸ Corrected
 * text…, which acts on the open project. Both open the same dialog, which
 * names the project and takes pasted text or a file: plain text, SRT or
 * WebVTT. Nothing is replaced until a confirm that says what will change.
 *
 * The matching is word-alignment.js's alignTranscripts, as Add Transcript
 * used. What else the project keeps is decided by the text:
 *
 *  - text whose paragraphs start with a speaker in square brackets, as
 *    [Name], brings its own speakers and paragraph breaks; text without them
 *    keeps the project's, each paragraph where its words fall in time.
 *    Nothing else is read as a label, so "Note: …" keeps its first word
 *  - a word left unchanged and still at its time keeps its strike-out, and a
 *    struck-out word the text leaves out stays where it was, still struck
 *    out: the editor's caption downloads leave struck words out, and pasting
 *    one back must not undo the cuts
 *  - a caption file's captions become the project's captions, keeping the
 *    file's own splits and times, as an import does. Otherwise the captions
 *    are built from the new words.
 *
 * The replacement goes through the transcript gateway, so it is one undo
 * step. The captions it replaces cannot be undone (#535).
 *
 * Exposed as window.hyperaudioCorrectedText(id), id optional, which resolves
 * to null when the dialog is open, or to a reason it is not, for the caller
 * to show. Remove this file and both entries do nothing more than say so.
 */
(function () {
  'use strict';

  const modal = () => document.getElementById('align-modal');
  const textBox = () => document.getElementById('align-text-input');
  const fileInput = () => document.getElementById('align-file-input');
  const saveApi = () => window.HyperaudioSave || null;

  const say = async (message, title) => {
    const save = saveApi();
    if (save && typeof save.dialog === 'function') {
      await save.dialog(message, { title: title || 'Corrected text', cancelButton: false, confirmLabel: 'OK' });
    }
  };

  /* ---- the text: what kind it is, and its words as plain text ------------ */

  // Decided by the content, not the file's name: a caption file pasted into
  // the box is still a caption file, and its numbers and times must not be
  // matched as words
  function kindOf(raw) {
    const text = String(raw).replace(/^﻿/, '');
    if (/^WEBVTT(?:[ \t]|\r?\n|$)/.test(text)) return 'vtt';
    if (/^\s*\d+[ \t]*\r?\n[ \t]*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}[ \t]*-->/.test(text)) return 'srt';
    return 'text';
  }

  // A caption file's words, one paragraph per line as the importer places
  // them. Voice and class tags are taken out first: they carry no words, and
  // the importer would keep them as text
  function captionWords(raw, kind) {
    const converters = window.HyperaudioConverters;
    if (!converters) return null;
    const cleaned = String(raw).replace(/<\/?(?:v|c|lang|ruby|rt)(?:[.\s][^>]*)?>/gi, '');
    const html = kind === 'srt' ? converters.srt(cleaned) : converters.vtt(cleaned);
    if (typeof html !== 'string') return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('p')]
      .map((p) => [...p.querySelectorAll('span[data-m]')].map((s) => s.textContent.trim()).filter(Boolean).join(' '))
      .filter((line) => line !== '')
      .join('\n');
  }

  // The captions the file brings, as WebVTT
  function captionTrackOf(raw, kind) {
    if (kind === 'srt') {
      return typeof window.convertSrtToWebVtt === 'function' ? window.convertSrtToWebVtt(raw) : null;
    }
    const converters = window.HyperaudioConverters;
    return converters && typeof converters.withoutInlineTimes === 'function' ? converters.withoutInlineTimes(raw) : raw;
  }

  // A speaker in square brackets at the start of a paragraph. Only brackets:
  // the aligner's own rule also takes "Note: " as a label, and its word
  // would be lost
  const LABEL = /^\[([^\]]+)\]\s*:?\s*/;

  // The text's paragraphs, each with its speaker if labels are read, and
  // its words
  function linesOf(text, readLabels) {
    return String(text).split(/\n+/).map((line) => {
      let rest = line.trim();
      let speaker = null;
      const label = readLabels ? LABEL.exec(rest) : null;
      if (label !== null) { speaker = label[1].trim(); rest = rest.slice(label[0].length); }
      return { speaker, words: rest.split(/\s+/).filter(Boolean) };
    }).filter((line) => line.words.length > 0);
  }

  // Does the text bring its own speakers?
  function hasSpeakerLabels(text) {
    return String(text).split(/\n+/).some((line) => LABEL.test(line.trim()));
  }

  /* ---- the replacement --------------------------------------------------- */

  // The project's paragraphs that still hold a word, the way jsonToHTML
  // places words: each in the last paragraph that has started by its time
  function paragraphsKept(paragraphs, words) {
    const used = new Set();
    words.forEach((word) => {
      let idx = 0;
      paragraphs.forEach((p, i) => { if (p.start <= word.start) idx = i; });
      used.add(idx);
    });
    return paragraphs.filter((p, i) => used.has(i));
  }

  const wordKey = (word) => Math.round(word.start * 1000) + '|'
    + (typeof normalizeWord === 'function' ? normalizeWord(word.text) : String(word.text).toLowerCase());

  // The aligner's steps, called one by one so that only bracketed labels
  // are taken out of the text (alignTranscripts strips any "Label: ")
  function replacedHtml(transcript, text, keepStructure) {
    const before = htmlToJSON(transcript);
    if (!before.words || before.words.length === 0) return null;
    const { words: sourceWords, timings } = extractWordsFromJSON(before);
    const lines = linesOf(text, !keepStructure);
    const targetWords = lines.flatMap((line) => line.words);
    const alignment = alignWords(sourceWords, targetWords);
    // every word of the text comes out once, in order
    const after = generateAlignedJSON(alignment, sourceWords, targetWords, timings, targetWords.join(' '));

    // unchanged words keep their strike-out
    const struck = new Set(before.words.filter((w) => w.struck === true).map(wordKey));
    if (struck.size > 0) after.words.forEach((w) => { if (struck.has(wordKey(w))) w.struck = true; });

    // the text's paragraphs, from the word each one starts with
    if (!keepStructure) {
      let at = 0;
      after.paragraphs = lines.map((line) => {
        const first = after.words[at];
        const last = after.words[at + line.words.length - 1];
        at += line.words.length;
        return { start: first.start, end: last.end, speaker: line.speaker };
      });
    }

    // a struck-out word the text leaves out stays, at its own time
    alignment.forEach((step) => {
      if (step.type !== 'delete') return;
      const word = before.words[step.sourceIdx];
      if (word && word.struck === true) after.words.push(Object.assign({}, word));
    });
    after.words.sort((a, b) => a.start - b.start);

    if (keepStructure && Array.isArray(before.paragraphs) && before.paragraphs.length > 0) {
      after.paragraphs = paragraphsKept(before.paragraphs, after.words);
    }
    return jsonToHTML(after);
  }

  function applyCaptions(vtt) {
    if (vtt === null) {
      // built from the new words, and following the transcript from here
      try { updateCaptionsFromTranscript = true; } catch (e) { /* editor-core absent */ }
      if (typeof hyperaudioGenerateCaptionsFromTranscript === 'function') hyperaudioGenerateCaptionsFromTranscript();
      return;
    }
    // the file's captions, as the SRT and VTT imports put them in place,
    // without the new-project signal those imports also send
    // a data: address, which is what the project saves its captions from
    const url = 'data:text/vtt,' + encodeURIComponent(vtt);
    if (typeof window.applyCaptionTrack === 'function') window.applyCaptionTrack(url, { mode: 'showing' });
    try { updateCaptionsFromTranscript = false; } catch (e) { /* editor-core absent */ }
    if (typeof populateCaptionEditorFromVtt === 'function') populateCaptionEditorFromVtt(vtt);
    document.dispatchEvent(new CustomEvent('hyperaudioCaptionsEdited'));
  }

  /* ---- the dialog -------------------------------------------------------- */

  let projectName = 'this project';

  async function submit() {
    const file = fileInput() && fileInput().files[0];
    const raw = file ? await file.text() : textBox().value;
    if (String(raw).trim() === '') {
      await say('Paste the corrected text, or choose a file.');
      return;
    }
    const kind = kindOf(String(raw).trim());
    const text = kind === 'text' ? String(raw).trim() : captionWords(raw, kind);
    if (!text) {
      await say('No words were found in the ' + (kind === 'text' ? 'text' : 'caption file') + '.');
      return;
    }
    const ownSpeakers = kind === 'text' && hasSpeakerLabels(text);
    const save = saveApi();
    const kept = ownSpeakers ? 'keeps their timings and struck-out words' : 'keeps their timings, speaker names and struck-out words';
    const message = 'This replaces the words' + (ownSpeakers ? ' and speaker names' : '') + ' of “' + projectName + '” and '
      + kept + '. '
      + (kind === 'text' ? 'The captions are rebuilt from the new words.' : 'The captions are replaced by the file’s captions.')
      + ' Duplicate the project first to keep a copy.';
    if (save && typeof save.dialog === 'function') {
      const go = await save.dialog(message, { title: 'Corrected text', warning: true, confirmLabel: 'Replace' });
      if (go !== true) return;
    }

    const transcript = document.getElementById('hypertranscript');
    if (transcript === null || transcript.querySelector('span[data-m]') === null) {
      await say('The project has no timed words to match the text to.');
      return;
    }
    let html = null;
    try {
      html = replacedHtml(transcript, text, !ownSpeakers);
    } catch (error) {
      console.error('Corrected text:', error);
      await say('The text could not be matched to the project’s words. Nothing was changed.');
      return;
    }
    if (html === null) {
      await say('The project has no timed words to match the text to.');
      return;
    }
    // the edit signal inside the same transaction, so the history records
    // one step, as Replace All does
    const replace = () => {
      transcript.innerHTML = html;
      transcript.dispatchEvent(new Event('input', { bubbles: true }));
    };
    if (window.transcriptGateway && typeof window.transcriptGateway.mutate === 'function') {
      window.transcriptGateway.mutate(replace, { origin: 'corrected-text' });
    } else {
      replace();
    }
    if (typeof hyperaudio === 'function') hyperaudio();
    applyCaptions(kind === 'text' ? null : captionTrackOf(raw, kind));

    modal().checked = false;
    textBox().value = '';
    if (fileInput()) fileInput().value = '';
  }

  async function openFor(id) {
    const save = saveApi();
    if (document.documentElement.classList.contains('ha-transcribing')) {
      return 'A transcription is running. Wait for it to finish, then try again.';
    }
    if (save && save.library && id !== undefined && id !== null && typeof save.library.open === 'function') {
      // the project first, unless it is the open one: opening that is a no-op
      if (await save.library.open(id) === false) return 'The project could not be opened.';
    }
    if (document.documentElement.classList.contains('ha-readonly')) {
      return 'This project is open for editing in another tab, so its words can’t be replaced here.';
    }
    // the words live in the transcript view
    const toTranscript = document.getElementById('transcript-editor-btn');
    if (document.getElementById('captions-display') !== null && toTranscript !== null) toTranscript.click();
    const transcript = document.getElementById('hypertranscript');
    if (transcript === null || transcript.querySelector('span[data-m]') === null) {
      return 'This project has no timed words to match corrected text to.';
    }
    projectName = 'this project';
    if (save && save.library && typeof save.library.list === 'function') {
      const current = typeof save.library.currentId === 'function' ? save.library.currentId() : null;
      const entry = (await save.library.list()).find((p) => p.id === current);
      if (entry && entry.name) projectName = entry.name;
    }
    const named = document.getElementById('align-project-name');
    if (named !== null) named.textContent = projectName;
    // on a phone the library is a drawer over the page: out of the way first
    const backdrop = document.getElementById('drawer-backdrop');
    if (backdrop !== null && document.body.classList.contains('drawer-open')) backdrop.click();
    modal().checked = true;
    return null;
  }

  // the File menu item acts on the open project
  async function fromMenu() {
    const reason = await openFor(null);
    if (reason !== null) await say(reason);
  }

  function wire() {
    const menuItem = document.getElementById('upload-align-btn');
    if (menuItem !== null) menuItem.addEventListener('click', fromMenu);
    const go = document.getElementById('align-text-btn');
    if (go !== null) go.addEventListener('click', () => { submit(); });
    // a file chosen takes the place of anything typed
    const input = fileInput();
    if (input !== null) input.addEventListener('change', () => { if (input.files[0]) textBox().value = ''; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.hyperaudioCorrectedText = openFor;
  // for the unit tests
  window.hyperaudioCorrectedTextParts = { kindOf, hasSpeakerLabels, linesOf, paragraphsKept };
})();

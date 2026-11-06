/**
 * selection-length.js
 * (C) The Hyperaudio Project
 * @version 1.3.45 — last changed in release 1.3.45
 * @license AGPL-3.0-only
 *
 * How long the selected passage runs (#775), shown beside the player's clock
 * while something is selected in the transcript: the selected words' own
 * times, and the length a clip of them would be exported at, with struck
 * words and skipped silences left out, so it is the number the Export
 * dialog's Selection option would show.
 *
 * Reads the selection through transcript-selection.js and the clip through
 * media-export.js, so the three cannot disagree. Remove this file and the
 * chip never shows.
 */
(() => {
  'use strict';

  const chip = () => document.getElementById('playbar-selection');
  const player = () => document.getElementById('hyperplayer');

  const hide = () => {
    const el = chip();
    if (el !== null && !el.hidden) el.hidden = true;
  };

  const onScreen = (sel) => {
    const ht = document.getElementById('hypertranscript');
    if (ht === null) return false;
    if (ht.querySelector('.' + sel.MARK) !== null) return true;
    const native = window.getSelection();
    if (native === null || native.rangeCount === 0) return false;
    const range = native.getRangeAt(0);
    return !range.collapsed && range.intersectsNode(ht);
  };

  const render = () => {
    const el = chip();
    const sel = window.TranscriptSelection;
    const clip = window.MediaExportClip;
    if (el === null || !sel || !clip) return;
    // Shown while the selection is on screen: the native one in the
    // transcript, or the mark a dialog leaves in its place (#732). The
    // remembered selection outlives both for the dialogs' sake, and a chip
    // for a selection nobody can see would only puzzle.
    if (!onScreen(sel)) { hide(); return; }
    const p = player();
    const duration = p !== null && Number.isFinite(p.duration) ? p.duration : Infinity;
    const range = clip.selectedClip(duration);
    if (range === null) { hide(); return; }
    const length = clip.keptDuration(clip.clipSections(duration, range));
    // every word struck out, or nothing to speak of: no clip to measure
    if (length < 0.05) { hide(); return; }
    const span = `${clip.fmtLen(range.from)}–${clip.fmtLen(range.to)}`;
    const len = clip.fmtLen(length);
    el.querySelector('#playbar-selection-span').textContent = span;
    el.querySelector('#playbar-selection-length').textContent = len;
    el.title = `Selected ${span}, ${len} as a clip`;
    if (el.hidden) el.hidden = false;
  };

  // a drag fires selectionchange on every move: one render a frame is plenty
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  };

  document.addEventListener('selectionchange', schedule);
  // an edit forgets the selection, a strike or a gap setting changes what is kept
  document.addEventListener('input', schedule, true);
  document.addEventListener('change', schedule);
  document.addEventListener('click', schedule);
  // a new transcript, or one restored from Recents
  document.addEventListener('hyperaudioInit', schedule);
  document.addEventListener('hyperaudioLibraryChanged', schedule);

  window.SelectionLength = Object.freeze({ render });
})();

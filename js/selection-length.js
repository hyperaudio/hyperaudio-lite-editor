/**
 * selection-length.js
 * (C) The Hyperaudio Project
 * @version 1.3.45 — last changed in release 1.3.45
 * @license AGPL-3.0-only
 *
 * How long the selected passage runs (#775), shown in the transcript card's
 * bottom-left corner while something is selected in the transcript: the
 * selected words' own times, and the length a clip of them would be exported
 * at, with struck words and skipped silences left out, so it is the number
 * the Export dialog's Selection option would show.
 *
 * The pill is the read-only badge's mirror, and like it sits beside the
 * transcript rather than inside it, so it never becomes part of the content.
 * It takes no clicks. Reads the selection through transcript-selection.js
 * and the clip through media-export.js, so the three cannot disagree.
 * Remove this file and the pill never shows.
 */
(() => {
  'use strict';

  const ID = 'selection-length';
  const player = () => document.getElementById('hyperplayer');

  // the pill, made when first needed
  const pill = () => {
    let el = document.getElementById(ID);
    if (el !== null) return el;
    el = document.createElement('div');
    el.id = ID;
    el.hidden = true;
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<span class="selection-length-span"></span><span class="selection-length-length"></span>';
    document.body.appendChild(el);
    return el;
  };

  const hide = () => {
    const el = document.getElementById(ID);
    if (el !== null && !el.hidden) el.hidden = true;
  };

  // Shown while the selection is on screen: the native one in the
  // transcript, or the mark a dialog leaves in its place (#732). The
  // remembered selection outlives both for the dialogs' sake, and a number
  // for a selection nobody can see would only puzzle.
  const onScreen = (sel, ht) => {
    if (ht.querySelector('.' + sel.MARK) !== null) return true;
    const native = window.getSelection();
    if (native === null || native.rangeCount === 0) return false;
    const range = native.getRangeAt(0);
    return !range.collapsed && range.intersectsNode(ht);
  };

  const render = () => {
    const sel = window.TranscriptSelection;
    const clip = window.MediaExportClip;
    const ht = document.getElementById('hypertranscript');
    if (!sel || !clip || ht === null || !onScreen(sel, ht)) { hide(); return; }
    const p = player();
    const duration = p !== null && Number.isFinite(p.duration) ? p.duration : Infinity;
    const range = clip.selectedClip(duration);
    if (range === null) { hide(); return; }
    const length = clip.keptDuration(clip.clipSections(duration, range));
    // every word struck out, or nothing to speak of: no clip to measure, as
    // the dialog offers none (the padding either side would still count)
    const struck = (w) => (w.style.textDecoration || '').includes('line-through');
    if (length < 0.05 || sel.words().every(struck)) { hide(); return; }
    const el = pill();
    const span = `${clip.fmtLen(range.from)}–${clip.fmtLen(range.to)}`;
    const len = clip.fmtLen(length);
    el.querySelector('.selection-length-span').textContent = span;
    el.querySelector('.selection-length-length').textContent = len;
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

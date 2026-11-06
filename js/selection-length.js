/**
 * selection-length.js
 * (C) The Hyperaudio Project
 * @version 1.3.45 — last changed in release 1.3.45
 * @license AGPL-3.0-only
 *
 * How long the selected passage runs (#775), shown just under the selection
 * while something is selected in the transcript: the selected words' own
 * times, and the length a clip of them would be exported at, with struck
 * words and skipped silences left out, so it is the number the Export
 * dialog's Selection option would show.
 *
 * The badge sits in the transcript's scrolling card, beside the transcript
 * rather than inside it, so it moves with the text and never becomes part of
 * the content. It takes no clicks. Reads the selection through
 * transcript-selection.js and the clip through media-export.js, so the three
 * cannot disagree. Remove this file and the badge never shows.
 */
(() => {
  'use strict';

  const ID = 'selection-length';
  const GAP = 4;          // px under the selection's last line
  const player = () => document.getElementById('hyperplayer');
  const holder = () => document.querySelector('.transcript-holder');

  // the badge, made when needed: the card's contents are replaced on the
  // way to the captions view and back, and it goes with them
  const badge = () => {
    let el = document.getElementById(ID);
    if (el !== null) return el;
    const card = holder();
    if (card === null) return null;
    el = document.createElement('div');
    el.id = ID;
    el.hidden = true;
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<span class="selection-length-span"></span><span class="selection-length-length"></span>';
    card.appendChild(el);
    return el;
  };

  const hide = () => {
    const el = document.getElementById(ID);
    if (el !== null && !el.hidden) el.hidden = true;
  };

  // Where the selection ends on screen: the last client rect of the native
  // selection in the transcript, or of the last marked word when a dialog
  // left its mark in the selection's place (#732). Null when neither shows.
  const endRect = (sel, ht) => {
    const native = window.getSelection();
    if (native !== null && native.rangeCount > 0) {
      const range = native.getRangeAt(0);
      if (!range.collapsed && range.intersectsNode(ht)) {
        const rects = range.getClientRects();
        if (rects.length > 0) return rects[rects.length - 1];
      }
    }
    const marked = ht.querySelectorAll('.' + sel.MARK);
    if (marked.length > 0) return marked[marked.length - 1].getBoundingClientRect();
    return null;
  };

  const render = () => {
    const sel = window.TranscriptSelection;
    const clip = window.MediaExportClip;
    const ht = document.getElementById('hypertranscript');
    const card = holder();
    if (!sel || !clip || ht === null || card === null) { hide(); return; }
    const at = endRect(sel, ht);
    if (at === null) { hide(); return; }
    const p = player();
    const duration = p !== null && Number.isFinite(p.duration) ? p.duration : Infinity;
    const range = clip.selectedClip(duration);
    if (range === null) { hide(); return; }
    const length = clip.keptDuration(clip.clipSections(duration, range));
    // every word struck out, or nothing to speak of: no clip to measure, as
    // the dialog offers none (the padding either side would still count)
    const struck = (w) => (w.style.textDecoration || '').includes('line-through');
    if (length < 0.05 || sel.words().every(struck)) { hide(); return; }
    const el = badge();
    if (el === null) return;
    const span = `${clip.fmtLen(range.from)}–${clip.fmtLen(range.to)}`;
    const len = clip.fmtLen(length);
    el.querySelector('.selection-length-span').textContent = span;
    el.querySelector('.selection-length-length').textContent = len;
    el.title = `Selected ${span}, ${len} as a clip`;
    el.hidden = false;
    // Level with the selection's last line, in the margin to the right of
    // the transcript, where nothing is written. A narrow card has no margin:
    // then at the end of the line if the line has room, and under it if not.
    const cardRect = card.getBoundingClientRect();
    const textRect = ht.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left;
    let top = at.top + (at.height - height) / 2;
    if (cardRect.right - textRect.right >= width + 2 * GAP) {
      left = textRect.right + GAP;
    } else if (textRect.right - at.right >= width + 2 * GAP) {
      left = at.right + GAP;
    } else {
      left = Math.max(cardRect.left + GAP, Math.min(at.right - width, cardRect.right - width - GAP));
      top = at.bottom + GAP;
    }
    el.style.left = `${Math.round(left - cardRect.left + card.scrollLeft)}px`;
    el.style.top = `${Math.round(top - cardRect.top + card.scrollTop)}px`;
  };

  // a drag fires selectionchange on every move: one render a frame is plenty
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  };

  document.addEventListener('selectionchange', schedule);
  // an edit forgets the selection, a strike or a gap setting changes what is
  // kept, and a reflow moves the lines
  document.addEventListener('input', schedule, true);
  document.addEventListener('change', schedule);
  document.addEventListener('click', schedule);
  window.addEventListener('resize', schedule);
  // a new transcript, or one restored from Recents
  document.addEventListener('hyperaudioInit', schedule);
  document.addEventListener('hyperaudioLibraryChanged', schedule);

  window.SelectionLength = Object.freeze({ render });
})();

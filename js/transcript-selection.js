/**
 * transcript-selection.js
 * (C) The Hyperaudio Project
 * @version 1.3.41 — last changed in release 1.3.41
 * @license MIT
 *
 * What is selected in the transcript, as a stretch of media — for anything
 * that acts on "the selection" from a dialog: exporting a clip (#689), and
 * whatever else offers the same choice. One rule, so they cannot disagree.
 *
 * Opening a dialog moves the selection away from the transcript, so the last
 * selection made IN the transcript is remembered as it is made. A click back
 * into the transcript (a collapsed selection there) forgets it, so an old
 * selection never comes back as a surprise. Selecting elsewhere on the page
 * leaves it alone.
 *
 * A selection counts when it overlaps the transcript, not only when it lies
 * wholly inside it: a long drag easily starts or ends just past the text — in
 * the margin, below the last line, over the player — and was then ignored
 * altogether. Only the transcript's own words in it are used.
 *
 * A word counts when some of its text is selected, not merely its edge.
 * Speaker labels are not words. Remove this file and every dialog simply
 * offers no selection.
 *
 * The native selection collapses the moment a dialog is used, so when the
 * dialog closes the remembered words are shown as selected again (#732):
 * a mark of our own on each word, drawn like the selection, which a dialog
 * asks for with show(). It is a selection for the dialogs' purposes, since
 * they read the record it is drawn from, and it goes the way a selection
 * would: a new selection, a click in the transcript, or an edit.
 */
(function () {
  const PAD = 0.1;   // seconds either side, so no word is clipped at its edge
  const MARK = 'transcript-selected';
  let last = null;

  function hide() {
    document.querySelectorAll('.' + MARK).forEach((el) => el.classList.remove(MARK));
  }
  // The selection used up, as a native one is by an edit or a strike: gone,
  // and no longer offered by a dialog either.
  function forget() {
    last = null;
    hide();
  }
  // Show the remembered selection as selected, when there is one on screen.
  // Returns whether anything was shown.
  function show() {
    hide();
    const selected = words();
    selected.forEach((el) => el.classList.add(MARK));
    return selected.length > 0;
  }

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const ht = document.getElementById('hypertranscript');
    if (sel === null || sel.rangeCount === 0 || ht === null) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) {
      if (ht.contains(range.startContainer)) { last = null; hide(); }   // a click in the transcript
      return;
    }
    if (range.intersectsNode(ht)) {
      // a different selection: the real one shows now. The same one again
      // (the native selection is still alive when a dialog opens) keeps the mark.
      const same = last !== null && last.startContainer.isConnected && last.endContainer.isConnected
        && range.compareBoundaryPoints(Range.START_TO_START, last) === 0
        && range.compareBoundaryPoints(Range.END_TO_END, last) === 0;
      last = range.cloneRange();
      if (!same) hide();
    }
  });
  // an edit is a selection gone, as it would be natively: forgotten, not
  // only hidden, or the next export still offered the old range
  document.addEventListener('input', (e) => {
    const ht = document.getElementById('hypertranscript');
    if (ht !== null && e.target && ht.contains(e.target)) forget();
  }, true);

  // The word spans of the remembered selection, in order, or [] when there
  // is none or it no longer belongs to the transcript on screen.
  function words() {
    const range = last;
    const ht = document.getElementById('hypertranscript');
    if (range === null || ht === null || !range.startContainer.isConnected
        || !range.endContainer.isConnected || !range.intersectsNode(ht)) return [];
    const touched = (span) => {
      if (!range.intersectsNode(span)) return false;
      const part = document.createRange();
      part.selectNodeContents(span);
      if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
      return part.toString().trim() !== '';
    };
    return [...ht.querySelectorAll('[data-m]:not(.speaker)')].filter(touched);
  }

  // The selection as times, or null: from/to are the selected words' own
  // start and end; start/end the same padded by PAD and kept within the
  // media's duration, when that is known.
  function range(duration) {
    const selected = words();
    if (selected.length === 0) return null;
    const first = selected[0];
    const lastWord = selected[selected.length - 1];
    const from = parseInt(first.getAttribute('data-m'), 10) / 1000;
    const lastStart = parseInt(lastWord.getAttribute('data-m'), 10) / 1000;
    if (isNaN(from) || isNaN(lastStart)) return null;
    const lastDur = parseInt(lastWord.getAttribute('data-d'), 10);
    const to = lastStart + (isNaN(lastDur) ? 0.5 : lastDur / 1000);
    const cap = Number.isFinite(duration) ? duration : to + PAD;
    return { from, to, start: Math.max(0, from - PAD), end: Math.min(cap, to + PAD) };
  }

  window.TranscriptSelection = Object.freeze({ words, range, show, hide, forget, PAD, MARK });
})();

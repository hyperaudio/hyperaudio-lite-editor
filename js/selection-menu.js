/**
 * selection-menu.js
 * (C) The Hyperaudio Project
 * @version 1.3.48 — last changed in release 1.3.48
 * @license AGPL-3.0-only
 *
 * A small bar beside a selection in the transcript (#803): Strike out or
 * Unstrike, and Export selection. It appears once a drag has ended, or a
 * double-click has selected a word, and goes with the selection, with
 * Escape, with an edit, or when a dialog opens. The passage's times and
 * length stay in the corner pill (selection-length.js, #775).
 *
 * It acts through the toolbar's own paths, the strike button's click and the
 * export dialog, so captions, history and playback follow as they do from
 * there. A mousedown on the bar keeps focus and the selection where they
 * are, since the strike reads the live selection. Reads the selection
 * through transcript-selection.js, as the dialogs do, so the bar and the
 * dialogs cannot disagree about what is selected. Remove this file and no
 * bar shows.
 */
(() => {
  'use strict';

  const ID = 'selection-menu';
  const MARGIN = 8;   // px between the bar and the selection
  const EDGE = 16;    // px kept from the viewport's sides
  const STRIKE_SHORTCUT = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘⇧X' : 'Ctrl+Shift+X';

  const transcript = () => document.getElementById('hypertranscript');
  const holder = () => document.querySelector('.transcript-holder');
  const readOnly = () => document.documentElement.classList.contains('ha-readonly');
  const struck = (w) => (w.style.textDecoration || '').includes('line-through');

  let pointerDown = false;        // a drag in progress: no bar until it ends
  let lastPointerType = 'mouse';  // touch puts the system callout above, so the bar goes below
  let dismissed = false;          // Escape, until the selection changes
  // A double-click selects its word as a side effect of playing from it, as
  // often as by choice, so a selection made that way is not offered for
  // export. Any other way of selecting (a drag, a third click, the keyboard)
  // clears this.
  let byDoubleClick = false;

  // the toolbar's own icons, so the bar and the toolbar read alike
  const icon = (selector) => {
    const svg = document.querySelector(selector + ' svg');
    if (svg === null) return null;
    const copy = svg.cloneNode(true);
    copy.removeAttribute('width');
    copy.removeAttribute('height');
    copy.setAttribute('aria-hidden', 'true');
    return copy;
  };

  const button = (className, iconSelector, text) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    const svg = icon(iconSelector);
    if (svg !== null) el.appendChild(svg);
    const label = document.createElement('span');
    label.className = 'selection-menu-label';
    label.textContent = text;
    el.appendChild(label);
    return el;
  };

  // the bar, made when first needed
  const bar = () => {
    let el = document.getElementById(ID);
    if (el !== null) return el;
    el = document.createElement('div');
    el.id = ID;
    el.hidden = true;
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Selected words');
    const strike = button('selection-menu-strike', '#strikethrough', 'Strike out');
    const exp = button('selection-menu-export', '#export-media-btn', 'Export');
    exp.title = 'Export the selected words as a clip';
    exp.setAttribute('aria-label', 'Export the selected words as a clip');
    el.append(strike, exp);
    // keep focus and the native selection where they are: the strike reads it
    el.addEventListener('mousedown', (e) => e.preventDefault());
    strike.addEventListener('click', () => {
      const toolbarButton = document.getElementById('strikethrough');
      if (toolbarButton !== null) toolbarButton.click();
    });
    exp.addEventListener('click', exportSelection);
    document.body.appendChild(el);
    return el;
  };

  const hide = () => {
    const el = document.getElementById(ID);
    if (el !== null && !el.hidden) el.hidden = true;
  };

  // the live selection, when it is in the transcript and not collapsed
  const liveRange = () => {
    const ht = transcript();
    const sel = window.getSelection();
    if (ht === null || sel === null || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    return !range.collapsed && range.intersectsNode(ht) ? range : null;
  };

  // The export dialog, with the selection chosen as the clip. The dialog
  // leaves a single word unchosen when it opens from the toolbar (#776), a
  // double-click being a choice as often as not; from the bar the choice has
  // been made, so one word is chosen too.
  function exportSelection() {
    const toggle = document.getElementById('export-modal');
    if (toggle === null) return;
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    const clipRadio = document.getElementById('export-source-clip');
    if (clipRadio !== null && !clipRadio.disabled && !clipRadio.checked) {
      clipRadio.checked = true;
      clipRadio.dispatchEvent(new Event('change'));
    }
    hide();
  }

  // Above the selection, centred, within the viewport's sides. Below it when
  // there is no room above within the transcript card, or on touch, where
  // the system's own callout sits above. False when the selection has
  // scrolled out of the card.
  const place = (el, range) => {
    const rect = range.getBoundingClientRect();
    const card = holder();
    const cardRect = card !== null ? card.getBoundingClientRect() : null;
    if (cardRect !== null && (rect.bottom < cardRect.top || rect.top > cardRect.bottom)) return false;
    el.hidden = false;   // to measure it
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = Math.max(EDGE, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - EDGE - width));
    const roomAbove = rect.top - height - MARGIN >= (cardRect !== null ? cardRect.top : 0);
    const below = lastPointerType === 'touch' || !roomAbove;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(below ? rect.bottom + MARGIN : rect.top - height - MARGIN)}px`;
    el.classList.toggle('is-below', below);
    return true;
  };

  const render = () => {
    const sel = window.TranscriptSelection;
    const range = liveRange();
    // never behind an open dialog: its own controls can fire the events that
    // bring the bar back
    const dialogOpen = document.querySelector('.modal-toggle:checked') !== null;
    // a setting on the Application tab turns the bar off (#803)
    const off = window.HyperaudioSettings && window.HyperaudioSettings.get('selectionBar') === false;
    if (off || !sel || pointerDown || dismissed || dialogOpen || range === null) { hide(); return; }
    const words = sel.words();
    if (words.length === 0) { hide(); return; }
    const allStruck = words.every(struck);
    const el = bar();

    const strike = el.querySelector('.selection-menu-strike');
    strike.hidden = readOnly();
    strike.querySelector('.selection-menu-label').textContent = allStruck ? 'Unstrike' : 'Strike out';
    const strikeTip = allStruck
      ? `Put the selected words back in the audio and video (${STRIKE_SHORTCUT})`
      : `Cut the selected words from the audio and video (${STRIKE_SHORTCUT})`;
    strike.title = strikeTip;
    strike.setAttribute('aria-label', strikeTip);

    // words that are all struck out have nothing to export, as the dialog says
    el.querySelector('.selection-menu-export').hidden = allStruck || byDoubleClick;

    if (!place(el, range)) hide();
  };

  // a drag fires selectionchange on every move: one render a frame is plenty
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  };

  document.addEventListener('selectionchange', () => { dismissed = false; schedule(); });
  document.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType || 'mouse';
    const ht = transcript();
    if (ht !== null && e.target instanceof Node && ht.contains(e.target)) { pointerDown = true; hide(); }
  }, true);
  const pointerEnded = () => { if (pointerDown) { pointerDown = false; schedule(); } };
  document.addEventListener('pointerup', pointerEnded, true);
  document.addEventListener('pointercancel', pointerEnded, true);
  // the click count, read on mousedown
  document.addEventListener('mousedown', (e) => {
    const ht = transcript();
    if (ht !== null && e.target instanceof Node && ht.contains(e.target)) byDoubleClick = e.detail === 2;
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') byDoubleClick = false;
    if (e.key === 'Escape' && document.getElementById(ID) !== null && !document.getElementById(ID).hidden) { dismissed = true; hide(); }
  });
  // an edit forgets the selection, a strike or a gap setting changes what is kept
  document.addEventListener('input', schedule, true);
  document.addEventListener('change', (e) => {
    // a dialog opening takes the selection with it (#732): the bar goes too
    if (e.target instanceof Element && e.target.classList.contains('modal-toggle') && e.target.checked) { hide(); return; }
    schedule();
  });
  document.addEventListener('click', schedule);
  // the selection moves with the text
  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  // a new transcript, or one restored from Recents
  document.addEventListener('hyperaudioInit', hide);
  document.addEventListener('hyperaudioLibraryChanged', schedule);

  window.SelectionMenu = Object.freeze({ render, hide });
})();

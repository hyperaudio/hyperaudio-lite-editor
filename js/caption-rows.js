/**
 * caption-rows.js
 * (C) The Hyperaudio Project
 * @version 1.3.45 — last changed in release 1.3.45
 * @license AGPL-3.0-only
 *
 * What a caption row does beyond being typed into (#773). The rows are built
 * by populateCaptionEditor (editor-main.js) from the template in index.html,
 * and insert, merge and delete live there too. This module adds, by
 * delegation so that rebuilt rows need no wiring of their own:
 *
 *  - the row menu: insert, merge and delete, with merge withheld on the
 *    last row, and the menu closed by a click elsewhere or Escape
 *  - the editor follows the media: the playing cue is marked and kept in
 *    view, and clicking a time seeks there
 *  - the text: Enter moves to the second line and a third line is refused,
 *    a pasted third line folds onto the second, and each line's length shows
 *    at its right edge, red past the limit
 *  - the keyboard: Alt+[ and Alt+] set In and Out from the playhead, and
 *    Alt+Up and Alt+Down nudge a focused time by a tenth of a second
 *
 * Without this script the rows still type, play and seek as before, and the
 * menu's items do nothing.
 */
(() => {
  'use strict';

  const LINE_LIMIT = 42;        // characters on a line, the broadcast rule of thumb
  const NUDGE = 0.1;            // seconds, Alt+Up and Alt+Down
  const OUT_LEAD = 0.1;         // seeking to an Out lands just before it, as seekTo does

  const display = () => document.getElementById('captions-display');
  const player = () => document.getElementById('hyperplayer');
  const rowOf = (el) => (el && typeof el.closest === 'function' ? el.closest('#captions-display .caption') : null);
  const rowsOf = (root) => (root === null ? [] : Array.from(root.querySelectorAll('.caption')));
  const nextRow = (row) => {
    const next = row.nextElementSibling;
    return next !== null && next.classList.contains('caption') ? next : null;
  };

  // "00:01:13.520" or "01:13.520" to seconds, NaN for a timecode half typed
  const seconds = (value) => {
    const text = String(value === undefined || value === null ? '' : value).trim();
    const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(text);
    if (m === null) return NaN;
    const hours = m[1] === undefined ? 0 : Number(m[1]);
    return hours * 3600 + Number(m[2]) * 60 + Number(m[3])
      + (m[4] === undefined ? 0 : Number(m[4].padEnd(3, '0')) / 1000);
  };

  // seconds to "00:01:13.520", the form the rows and the VTT use
  const timecode = (value) => {
    const total = Math.max(0, Math.round(Number(value) * 1000)) / 1000;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total - h * 3600 - m * 60;
    const two = (n) => String(n).padStart(2, '0');
    return `${two(h)}:${two(m)}:${s.toFixed(3).padStart(6, '0')}`;
  };

  // every caption edit goes through the one door editor-main keeps (#505)
  const edited = () => {
    if (typeof window.captionChange === 'function') window.captionChange();
  };

  const setTime = (row, which, value) => {
    const input = row.querySelector(which === 'end' ? '.end' : '.start');
    if (input === null || !Number.isFinite(value)) return;
    input.value = timecode(value);
    edited();
  };

  /* ---- the row menu ------------------------------------------------------ */

  // In or Out from the playhead, reached from the keyboard below
  const fromPlayhead = (row, which) => {
    const p = player();
    if (p !== null) setTime(row, which, p.currentTime);
  };

  const actions = {
    insert: (row, button) => { if (typeof window.addCaption === 'function') window.addCaption(button); },
    merge: (row, button) => { if (nextRow(row) !== null && typeof window.mergeCaption === 'function') window.mergeCaption(button); },
    delete: (row, button) => { if (typeof window.deleteCaption === 'function') window.deleteCaption(button); },
  };

  document.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[data-caption-action]') : null;
    if (button === null || button.disabled) return;
    const row = rowOf(button);
    if (row === null) return;
    const menu = button.closest('details');
    if (menu !== null) menu.open = false;
    const action = actions[button.getAttribute('data-caption-action')];
    if (action) action(row, button);
  });

  // a click anywhere outside an open menu closes it, as does Escape
  const closeMenus = (except) => rowsOf(display()).forEach((row) => {
    const menu = row.querySelector('details.caption-menu');
    if (menu !== null && menu !== except && menu.open) menu.open = false;
  });
  document.addEventListener('click', (event) => {
    const within = event.target && event.target.closest ? event.target.closest('details.caption-menu') : null;
    closeMenus(within);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && display() !== null) closeMenus(null);
  });

  // Opening a menu: the items that need a row after this one are disabled on
  // the last row, and a menu near the bottom of the list opens upward so it
  // is not clipped by the scrolling holder. toggle does not bubble, so it is
  // caught on the way down.
  document.addEventListener('toggle', (event) => {
    const menu = event.target;
    if (!(menu instanceof HTMLDetailsElement) || !menu.classList.contains('caption-menu')) return;
    const row = rowOf(menu);
    if (row === null) return;
    // the row paints beyond its box only while its menu is open (see the css)
    row.classList.toggle('caption-menu-open', menu.open);
    if (!menu.open) return;
    const last = nextRow(row) === null;
    menu.querySelectorAll('[data-caption-action="merge"]').forEach((item) => { item.disabled = last; });
    const holder = row.closest('.transcript-holder') || document.documentElement;
    const room = holder.getBoundingClientRect().bottom - menu.getBoundingClientRect().bottom;
    menu.classList.toggle('caption-menu-up', room < 240);
    // one menu open at a time
    rowsOf(display()).forEach((other) => {
      const theirs = other.querySelector('details.caption-menu');
      if (theirs !== null && theirs !== menu) theirs.open = false;
    });
  }, true);

  /* ---- the text: two lines, no more, each measured ---------------------- */

  const countsOf = (row) => {
    const area = row.querySelector('textarea.lines');
    const counts = row.querySelectorAll('.caption-count');
    if (area === null || counts.length < 2) return;
    const lines = String(area.value).split('\n');
    for (let i = 0; i < 2; i += 1) {
      const length = lines[i] === undefined ? 0 : lines[i].length;
      counts[i].textContent = length === 0 ? '' : String(length);
      counts[i].classList.toggle('caption-count-over', length > LINE_LIMIT);
    }
  };
  const refresh = () => rowsOf(display()).forEach(countsOf);

  // a third line, pasted or dropped in, folds onto the second
  const foldLines = (area) => {
    const parts = String(area.value).split('\n');
    if (parts.length <= 2) return false;
    const rest = parts.slice(1).map((part) => part.trim()).filter((part) => part !== '').join(' ');
    area.value = rest === '' ? parts[0] : parts[0] + '\n' + rest;
    area.setSelectionRange(area.value.length, area.value.length);
    return true;
  };

  document.addEventListener('input', (event) => {
    const area = event.target;
    if (!(area instanceof HTMLTextAreaElement) || !area.classList.contains('lines')) return;
    const row = rowOf(area);
    if (row === null) return;
    // the track was written from the unfolded text a moment ago. Not while
    // a composition is in flight: rewriting the text under it breaks it
    if (!event.isComposing && foldLines(area)) edited();
    countsOf(row);
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    // Alt+[ and Alt+]: In and Out from the playhead, for the row being edited
    // or else the row that is playing. First, since the text box takes the
    // other keys below.
    if (event.altKey && (event.code === 'BracketLeft' || event.code === 'BracketRight')) {
      if (display() === null) return;
      const row = rowOf(document.activeElement) || display().querySelector('.caption-current');
      if (row === null) return;
      event.preventDefault();
      fromPlayhead(row, event.code === 'BracketLeft' ? 'start' : 'end');
      return;
    }
    // Enter in the text: to the second line once, never a third
    // (not while a composition is in flight: there Enter confirms the text)
    if (target instanceof HTMLTextAreaElement && target.classList.contains('lines') && rowOf(target) !== null) {
      if (event.key === 'Enter' && !event.isComposing) {
        if (String(target.value).includes('\n')) event.preventDefault();
      }
      return;
    }
    // Alt+Up and Alt+Down on a focused time: a tenth of a second either way
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
        && target instanceof HTMLInputElement && (target.classList.contains('start') || target.classList.contains('end'))) {
      const row = rowOf(target);
      if (row === null) return;
      const at = seconds(target.value);
      if (!Number.isFinite(at)) return;
      event.preventDefault();
      setTime(row, target.classList.contains('end') ? 'end' : 'start', at + (event.key === 'ArrowUp' ? NUDGE : -NUDGE));
    }
  });

  /* ---- the editor follows the media -------------------------------------- */

  let current = null;

  const follow = () => {
    const root = display();
    const p = player();
    if (root === null || p === null) return;
    const t = p.currentTime;
    let found = null;
    for (const row of rowsOf(root)) {
      const start = seconds(row.querySelector('.start').value);
      const end = seconds(row.querySelector('.end').value);
      if (Number.isFinite(start) && Number.isFinite(end) && t >= start && t < end) { found = row; break; }
    }
    if (found === current && (found === null || found.classList.contains('caption-current'))) return;
    if (current !== null) current.classList.remove('caption-current');
    root.querySelectorAll('.caption-current').forEach((row) => row.classList.remove('caption-current'));
    current = found;
    if (found === null) return;
    found.classList.add('caption-current');
    // kept in view, unless the user is editing a row: then the view is theirs
    if (!root.contains(document.activeElement)) found.scrollIntoView({ block: 'nearest' });
  };

  const attach = () => {
    const p = player();
    if (p === null) return;
    p.addEventListener('timeupdate', follow);
    p.addEventListener('seeked', follow);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();

  // clicking a time seeks there (an Out, just before it), as the cue buttons do
  document.addEventListener('click', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || rowOf(input) === null) return;
    const isEnd = input.classList.contains('end');
    if (!isEnd && !input.classList.contains('start')) return;
    const at = seconds(input.value);
    const p = player();
    if (p === null || !Number.isFinite(at)) return;
    p.currentTime = Math.max(0, isEnd ? at - OUT_LEAD : at);
  });

  // rows freshly built, or changed through the one door: measure them, and
  // mark the one that is playing
  const built = () => { current = null; refresh(); follow(); };
  document.addEventListener('hyperaudioCaptionRowsBuilt', built);
  document.addEventListener('hyperaudioCaptionsEdited', () => { refresh(); follow(); });

  window.CaptionRows = Object.freeze({ LINE_LIMIT, NUDGE, seconds, timecode, refresh, follow });
})();

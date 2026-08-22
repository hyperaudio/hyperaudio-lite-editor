/**
 * responsive.js
 * (C) The Hyperaudio Project
 * @version 1.3.10 — last changed in release 1.3.10
 * @license MIT
 *
 * Small-screen UI toggles for the responsive layout (#349):
 * open/close the Recents off-canvas drawer via the existing #sidebar-toggle.
 * (Collapsing the pinned player is handled by the audio-only button, which
 * sets body.video-collapsed — see toggleAudioOnly in editor-main.js, #375.)
 *
 * Layout itself is CSS (css/hyperaudio-lite-editor.css, @media max-width:948px);
 * this only flips classes on <body>. No editor logic is touched, beyond
 * clearing a search the user can no longer see (#592).
 */

(function () {
  const body = document.body;
  const mobile = window.matchMedia('(max-width: 948px)');

  /* --- Where the transcript card starts (#580) -------------------------------
   * The card's top was a CSS constant per band — 78px wide, 58px compact —
   * each assuming a navbar height. The navbar has since grown: at 1000px it is
   * 74px tall against that 58px, so its grey band painted over the card's top
   * edge (losing the rounded corners) and over the ⓘ/copy buttons pinned to
   * it. Measuring is the only way that cannot go stale: the navbar's real
   * bottom, plus the 4px of canvas the wide layout has always shown, becomes
   * --card-top, and the card and every corner button derive from it.
   *
   * The mobile band (<=948px) pins the player under the navbar and computes
   * its own --card-top in CSS, so the inline value is REMOVED there — an
   * inline property would outrank that media query.
   * ------------------------------------------------------------------------ */
  const CANVAS_GAP = 4;
  const navbar = document.querySelector('.main-panel');

  const syncCardTop = () => {
    if (navbar === null) return;
    if (mobile.matches) {
      body.style.removeProperty('--card-top');
      return;
    }
    const bottom = Math.round(navbar.getBoundingClientRect().bottom);
    if (bottom > 0) body.style.setProperty('--card-top', (bottom + CANVAS_GAP) + 'px');
  };

  syncCardTop();
  window.addEventListener('resize', syncCardTop);
  mobile.addEventListener('change', syncCardTop);
  if (navbar !== null && typeof ResizeObserver === 'function') {
    // the navbar can change height after boot (a control arrives, a label
    // wraps), which is what made the overlap look intermittent
    new ResizeObserver(syncCardTop).observe(navbar);
  }
  // webfonts and late-injected toolbar buttons can settle after first paint
  window.addEventListener('load', syncCardTop);

  /* --- Hide the search when there is no room to type in it (#592) -----------
   * The input bottoms out at 48px — its own padding plus the clear button —
   * and then simply stays there: at 1000px wide it is a visible, focusable
   * stub with about 2px of room for text. There are two such bands, either
   * side of the 948px layout change, which is why a breakpoint per band would
   * be guesswork. What decides it is the room the navbar actually has, and
   * that is measurable.
   *
   * navbar-start and navbar-end are both flex: 0 0 auto, so they hold their
   * width whether the search is shown or hidden — the measurement cannot
   * chase its own result, which a min-width on the search itself would.
   * Below MIN_SEARCH_ROOM the box drops under ~100px and stops being typable.
   * The 580px CSS rule stays as the no-JS floor.
   * ------------------------------------------------------------------------ */
  const MIN_SEARCH_ROOM = 150;
  const navbarEl = document.querySelector('.main-panel .navbar');
  const navStart = document.querySelector('.navbar-start');
  const navEnd = document.querySelector('.navbar-end');

  const syncSearchRoom = () => {
    if (navbarEl === null || navStart === null || navEnd === null) return;
    const room = navbarEl.getBoundingClientRect().width
      - navStart.getBoundingClientRect().width
      - navEnd.getBoundingClientRect().width;
    const cramped = room < MIN_SEARCH_ROOM;
    if (cramped === body.classList.contains('search-cramped')) return;
    body.classList.toggle('search-cramped', cramped);
    // Going away with a query still live would strand highlighted matches in
    // the transcript with nothing on screen to clear them, so the existing
    // clear control is used rather than a second way to reset the search.
    if (cramped) {
      const clear = document.getElementById('search-clear');
      const box = document.getElementById('search-box');
      if (clear !== null && box !== null && box.value !== '') clear.click();
    }
  };

  syncSearchRoom();
  window.addEventListener('resize', syncSearchRoom);
  window.addEventListener('load', syncSearchRoom);
  if (navbarEl !== null && typeof ResizeObserver === 'function') {
    new ResizeObserver(syncSearchRoom).observe(navbarEl);
  }

  // --- Recents drawer --------------------------------------------------------
  // Keep #sidebar-toggle's aria-pressed tracking the drawer while in the
  // small-screen layout (editor-core.js owns it on desktop, where the same
  // button collapses the sidebar instead).
  const syncTogglePressed = () => {
    const toggle = document.getElementById('sidebar-toggle');
    if (toggle !== null && mobile.matches) {
      toggle.setAttribute('aria-pressed', String(body.classList.contains('drawer-open')));
    }
  };

  const openDrawer = () => { body.classList.add('drawer-open'); syncTogglePressed(); };
  const closeDrawer = () => { body.classList.remove('drawer-open'); syncTogglePressed(); };

  // Intercept #sidebar-toggle at the document capture phase so the desktop
  // sidebar-collapse handler (in editor-core.js) does not also fire on mobile.
  document.addEventListener('click', (event) => {
    const toggle = event.target.closest && event.target.closest('#sidebar-toggle');
    if (toggle !== null && toggle !== undefined && mobile.matches) {
      event.stopImmediatePropagation();
      event.preventDefault();
      body.classList.toggle('drawer-open');
      syncTogglePressed();
    }
  }, true);

  const backdrop = document.getElementById('drawer-backdrop');
  if (backdrop !== null) {
    backdrop.addEventListener('click', closeDrawer);
  }

  // Choosing a recent file closes the drawer.
  const filePicker = document.getElementById('file-picker');
  if (filePicker !== null) {
    filePicker.addEventListener('click', () => { if (mobile.matches) closeDrawer(); });
  }

  // Leaving the small-screen layout clears any drawer state; entering it
  // starts with the drawer closed.
  mobile.addEventListener('change', (ev) => { if (!ev.matches) closeDrawer(); else syncTogglePressed(); });
  syncTogglePressed();
})();

/**
 * responsive.js
 * (C) The Hyperaudio Project
 * @version 0.8.11 — last changed in release 0.8.11
 * @license MIT
 *
 * Small-screen UI toggles for the responsive layout (#349):
 * open/close the Recents off-canvas drawer via the existing #sidebar-toggle.
 * (Collapsing the pinned player is handled by the audio-only button, which
 * sets body.video-collapsed — see toggleAudioOnly in editor-main.js, #375.)
 *
 * Layout itself is CSS (css/hyperaudio-lite-editor.css, @media max-width:948px);
 * this only flips classes on <body>. No editor logic is touched.
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

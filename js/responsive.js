/**
 * responsive.js
 * (C) The Hyperaudio Project
 * @version 0.7.2 — last changed in release 0.7.2
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

  // --- Recents drawer --------------------------------------------------------
  const openDrawer = () => body.classList.add('drawer-open');
  const closeDrawer = () => body.classList.remove('drawer-open');

  // Intercept #sidebar-toggle at the document capture phase so the desktop
  // sidebar-collapse handler (in editor-core.js) does not also fire on mobile.
  document.addEventListener('click', (event) => {
    const toggle = event.target.closest && event.target.closest('#sidebar-toggle');
    if (toggle !== null && toggle !== undefined && mobile.matches) {
      event.stopImmediatePropagation();
      event.preventDefault();
      body.classList.toggle('drawer-open');
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

  // Leaving the small-screen layout clears any drawer state.
  mobile.addEventListener('change', (ev) => { if (!ev.matches) closeDrawer(); });
})();

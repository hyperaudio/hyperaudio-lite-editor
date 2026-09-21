/**
 * editor-service-worker.js
 * (C) The Hyperaudio Project
 * @version 1.3.21 — last changed in release 1.3.21
 * @license MIT
 *
 * Registers serviceworker.js, which is what lets the editor open offline.
 * Extracted from index.html (#334).
 */
  window.addEventListener('load', () => {
    registerSW();
  });

  // updateViaCache 'none': the browser's check for a new worker goes to the
  // network rather than its HTTP cache, so a release is seen on the next
  // visit instead of whenever a cached copy of the script expires (#665).
  async function registerSW() {
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('serviceworker.js', { updateViaCache: 'none' });
      } catch (e) {
        console.log('SW registration failed');
      }
    }
  }

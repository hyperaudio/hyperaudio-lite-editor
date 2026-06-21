/* Extracted verbatim from index.html (#334) — loaded as a classic script in the same document order. */
  window.addEventListener('load', () => {
    registerSW();
  });

  // Register the Service Worker
  async function registerSW() {
    if ('serviceWorker' in navigator) {
      try {
      await navigator
          .serviceWorker
          .register('serviceworker.js');
      }
      catch (e) {
      console.log('SW registration failed');
      }
    }
  }


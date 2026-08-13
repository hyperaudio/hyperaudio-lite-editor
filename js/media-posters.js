/**
 * media-posters.js
 * (C) The Hyperaudio Project
 * @version 1.3.4 — new in 1.3.4
 * @license MIT
 *
 * Project posters (#523 phase A): a first-frame JPEG captured from each
 * video project's media, stored as poster.jpg beside the project's other
 * OPFS files (work/<id>/ — the layout hyperaudio-save owns; this module is
 * a read/write guest there and touches nothing else). Capture is lazy and
 * idempotent: whenever the library changes, the CURRENT project's poster is
 * ensured — covering birth, open and media attach — so pre-existing
 * projects grow posters as they are visited. Audio media captures nothing
 * (the wave glyph in the hover popout is generated, not stored).
 *
 * Embedder seam: a host application may provide ready-made posters by
 * defining window.hyperaudioMediaPoster(entry) → url|null|Promise thereof;
 * when it yields a url, that wins and no canvas capture happens.
 *
 * Self-contained and removable: the library popout probes this module via
 * window.MediaPosters and degrades to its glyph when absent.
 */
(function mediaPosters() {
  const POSTER_NAME = 'poster.jpg';
  const CAPTURE_WIDTH = 320;
  const CAPTURE_TIMEOUT_MS = 8000;
  const urlCache = new Map(); // id → object URL of poster.jpg (or null probe result)

  async function projectDir(id, create) {
    const root = await navigator.storage.getDirectory();
    const work = await root.getDirectoryHandle('work', { create: false });
    return work.getDirectoryHandle(id, { create: create === true });
  }

  async function readPoster(id) {
    try {
      const dir = await projectDir(id, false);
      const handle = await dir.getFileHandle(POSTER_NAME);
      return await handle.getFile();
    } catch (e) {
      return null;
    }
  }

  async function firstMediaFile(id) {
    try {
      const dir = await projectDir(id, false);
      const mediaDir = await dir.getDirectoryHandle('media');
      for await (const [, handle] of mediaDir.entries()) {
        if (handle.kind === 'file') return handle.getFile();
      }
    } catch (e) { /* no media stored */ }
    return null;
  }

  // First-frame capture. Resolves null for audio (videoWidth 0), decode
  // failure, CORS taint, or timeout — null means "no poster", never throws.
  function captureFrameBlob(objectUrl) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      let settled = false;
      const done = (blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeAttribute('src');
        video.load();
        resolve(blob || null);
      };
      const timer = setTimeout(() => done(null), CAPTURE_TIMEOUT_MS);
      const tryDraw = () => {
        if (video.videoWidth <= 0 || video.readyState < 2 /* HAVE_CURRENT_DATA */) return;
        const canvas = document.createElement('canvas');
        canvas.width = CAPTURE_WIDTH;
        canvas.height = Math.max(1, Math.round(CAPTURE_WIDTH * video.videoHeight / video.videoWidth));
        try {
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => done(blob), 'image/jpeg', 0.75);
        } catch (e) {
          done(null); // tainted canvas or draw failure
        }
      };
      video.addEventListener('loadeddata', () => {
        // decode the true first frame, then draw on the seek's completion
        try { video.currentTime = 0.0001; } catch (e) { tryDraw(); }
      });
      video.addEventListener('seeked', tryDraw);
      video.addEventListener('canplay', tryDraw);
      video.addEventListener('error', () => done(null));
      video.src = objectUrl;
    });
  }

  let ensureChain = Promise.resolve(); // captures serialize; they're heavy
  function ensureProjectPoster(id) {
    ensureChain = ensureChain.then(async () => {
      if (!id) return;
      if (await readPoster(id) !== null) return; // once is enough
      const media = await firstMediaFile(id);
      if (media === null) return;
      const url = URL.createObjectURL(media);
      try {
        const blob = await captureFrameBlob(url);
        if (blob === null) return; // audio or uncapturable — the glyph serves
        const dir = await projectDir(id, false);
        const handle = await dir.getFileHandle(POSTER_NAME, { create: true });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        urlCache.delete(id); // next urlFor sees the fresh file
      } finally {
        URL.revokeObjectURL(url);
      }
    }).catch(() => { /* ensure never breaks a caller */ });
    return ensureChain;
  }

  // Poster URL for an entry: the embedder's poster wins; else the stored
  // capture; else null (caller shows its glyph). Cached per project id.
  async function urlFor(id, entry) {
    const hook = window.hyperaudioMediaPoster;
    if (typeof hook === 'function') {
      try {
        const hooked = await hook(entry || { id });
        if (hooked) return hooked;
      } catch (e) { /* the embedder's problem — fall through */ }
    }
    if (urlCache.has(id)) return urlCache.get(id);
    const file = await readPoster(id);
    if (file === null) return null; // a miss is not cached — posters arrive late
    const url = URL.createObjectURL(file);
    urlCache.set(id, url);
    return url;
  }

  document.addEventListener('hyperaudioLibraryChanged', () => {
    const lib = window.HyperaudioSave && window.HyperaudioSave.library;
    if (lib && typeof lib.currentId === 'function') ensureProjectPoster(lib.currentId());
  });

  window.MediaPosters = Object.freeze({ ensureProjectPoster, urlFor, captureFrameBlob });
})();

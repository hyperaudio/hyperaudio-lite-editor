/**
 * media-posters.js
 * (C) The Hyperaudio Project
 * @version 1.3.14 — last changed in release 1.3.14
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

  // Storage goes through the save module's own surface (#586) rather than
  // this module traversing OPFS a second time. It is internal, not an
  // injection point; if it is absent this module simply does nothing, which
  // is the right degradation for an optional feature.
  const store = () => (window.HyperaudioSave && window.HyperaudioSave.storage) || null;

  /* The wave glyph (#603) ----------------------------------------------------
   * An audio project has no frame to capture, and the library popout has long
   * drawn it a waveform instead. The player showed the markup poster — the
   * INTRO audio's artwork — so every audio project wore the same picture, and
   * the same project had two different faces depending on where you looked.
   *
   * The glyph lives here, in the module that owns what a project looks like,
   * and both places draw it from these three pieces. As an <img> it is an SVG
   * data URI: self-contained, no canvas, nothing to store, and it costs the
   * player nothing to show one.
   * ------------------------------------------------------------------------ */
  const GLYPH_STROKE = '#5b6472';
  // A waveform, not the 24px icon scaled up: the play badge sits dead centre
  // over the media, and a square glyph hid behind it. Bars spanning the frame
  // stay legible with the badge on top. Heights are fractions of the tallest.
  const WAVE_BARS = [
    0.30, 0.55, 0.85, 0.45, 0.70, 1.00, 0.60, 0.35, 0.75, 0.95,
    0.50, 0.80, 0.40, 0.65, 1.00, 0.55, 0.30, 0.70, 0.45,
  ];

  // Deterministic per-project hue, so audio projects differ at a glance
  // without anything being stored. FNV-1a rather than the h*31 walk (#618):
  // the seed is now a timestamp, and two recordings seconds apart differ in
  // one digit — a weak mix would put them a few degrees apart on the wheel.
  function glyphHue(seed) {
    let h = 0x811c9dc5;
    const s = String(seed === null || seed === undefined ? '' : seed);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % 360;
  }

  // What the hue hashes FROM (#618). The OPFS id is minted per app, so one
  // file wore unrelated colours in HLE and in Glider. `created` travels in
  // the .hyperaudio and is preserved on open, so hashing it gives a project
  // one colour wherever it turns up. Accepts a library entry (createdAt, ms)
  // or a state (created, ISO) — both normalise to the same instant — and a
  // bare id for callers that have nothing else, or entries from before the
  // field existed.
  function glyphSeed(entry) {
    if (entry === null || entry === undefined) return '';
    if (typeof entry !== 'object') return String(entry);
    const created = entry.createdAt !== undefined ? entry.createdAt : entry.created;
    const ms = typeof created === 'number' ? created : Date.parse(created);
    if (Number.isFinite(ms) && ms > 0) return 'created:' + ms;
    return String(entry.id || '');
  }

  // oklch, for uniform PERCEIVED lightness across the wheel: the hsl tint this
  // replaced (30% 88%) put every hue within a few steps of white, so the
  // per-project colour read as one pale grey everywhere (#618). One
  // definition, shared with the library's popout thumb.
  function glyphFill(entry) {
    return 'oklch(84% 0.09 ' + glyphHue(glyphSeed(entry)) + ')';
  }

  // 16:9 to match the popout's thumb, and so the player keeps the shape it has
  // with the markup poster rather than going square.
  function glyphUrl(entry) {
    const W = 640;
    const H = 360;
    const span = 240;              // the bars' width: well clear of the play badge
    const left = (W - span) / 2;
    const mid = H / 2;
    const maxHalf = 70;
    const step = span / (WAVE_BARS.length - 1);
    const bars = WAVE_BARS.map((f, i) => {
      const x = Math.round(left + i * step);
      const half = Math.round(maxHalf * f);
      return '<path d="M' + x + ' ' + (mid - half) + 'V' + (mid + half) + '"/>';
    }).join('');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '"'
      + ' viewBox="0 0 ' + W + ' ' + H + '">'
      + '<rect width="' + W + '" height="' + H + '" fill="' + glyphFill(entry) + '"/>'
      + '<g fill="none" stroke="' + GLYPH_STROKE + '" stroke-width="7"'
      + ' stroke-linecap="round" opacity="0.75">' + bars + '</g></svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  async function readPoster(id) {
    const s = store();
    if (s === null) return null;
    try {
      const dir = await s.projectDir(id, false);
      const handle = await dir.getFileHandle(POSTER_NAME);
      return await handle.getFile();
    } catch (e) {
      return null;
    }
  }

  const firstMediaFile = (id) => {
    const s = store();
    return s === null ? Promise.resolve(null) : s.firstMediaFile(id);
  };

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
        const s = store();
        if (s === null) return;
        const dir = await s.projectDir(id, false);
        await s.writeFile(dir, POSTER_NAME, blob);
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

  window.MediaPosters = Object.freeze({
    ensureProjectPoster, urlFor, captureFrameBlob, glyphUrl, glyphHue, glyphSeed, glyphFill,
  });
})();

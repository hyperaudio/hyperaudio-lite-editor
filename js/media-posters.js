/**
 * media-posters.js
 * (C) The Hyperaudio Project
 * @version 1.3.20 — last changed in release 1.3.20
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
  // Whether an entry (or a state) is known to carry a picture. Recorded on
  // the library entry from the player once metadata is in; entries from
  // before the field existed, and links whose metadata never arrived, are
  // unknown and draw as audio, which is what they always did.
  function glyphIsVideo(entry) {
    return !!(entry && typeof entry === 'object' && entry.media && entry.media.hasVideo === true);
  }

  // A short length of film for a video that has no picture of its own — a
  // link the server will not let a canvas read — so it is not drawn as a
  // soundwave. Centred, on the wave's footprint, so it reads the same way
  // the wave does with the play badge sitting over the middle of it.
  function filmStripSvg(W, H, fill) {
    const span = 240;                       // the wave's width
    const left = (W - span) / 2;
    const stripH = 150;
    const top = (H - stripH) / 2;
    const band = 26;                        // the sprocket bands, top and bottom
    const holeW = 16;
    const holeH = 11;
    const count = 8;
    const gap = span / count;
    const holes = [];
    for (let i = 0; i < count; i += 1) {
      const x = Math.round(left + i * gap + (gap - holeW) / 2);
      holes.push('<rect x="' + x + '" y="' + (top + (band - holeH) / 2) + '" width="' + holeW + '" height="' + holeH + '" rx="2.5"/>');
      holes.push('<rect x="' + x + '" y="' + (top + stripH - band + (band - holeH) / 2) + '" width="' + holeW + '" height="' + holeH + '" rx="2.5"/>');
    }
    return '<rect width="' + W + '" height="' + H + '" fill="' + fill + '"/>'
      + '<g fill="' + GLYPH_STROKE + '" opacity="0.75">'
      + '<rect x="' + left + '" y="' + top + '" width="' + span + '" height="' + band + '" rx="4"/>'
      + '<rect x="' + left + '" y="' + (top + stripH - band) + '" width="' + span + '" height="' + band + '" rx="4"/>'
      + '<rect x="' + left + '" y="' + (top + band) + '" width="' + span + '" height="' + (stripH - 2 * band) + '" opacity="0.25"/></g>'
      + '<g fill="' + fill + '">' + holes.join('') + '</g>';
  }

  function glyphUrl(entry) {
    const W = 640;
    const H = 360;
    const fill = glyphFill(entry);
    let body;
    if (glyphIsVideo(entry)) {
      body = filmStripSvg(W, H, fill);
    } else {
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
      body = '<rect width="' + W + '" height="' + H + '" fill="' + fill + '"/>'
        + '<g fill="none" stroke="' + GLYPH_STROKE + '" stroke-width="7"'
        + ' stroke-linecap="round" opacity="0.75">' + bars + '</g>';
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '"'
      + ' viewBox="0 0 ' + W + ' ' + H + '">' + body + '</svg>';
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

  // Where to look for a poster frame, in order (#582). Frame 1 was the
  // likeliest black frame in the whole clip — produced video fades in from
  // black, and a camera's exposure is still settling — so the capture now
  // starts around 5s and works outward: later, then earlier, then the true
  // first frame last. Clipped to the clip. A container that declares no
  // duration (MediaRecorder's webm) gets the 5s seek anyway, which clamps
  // to the last frame.
  function captureCandidates(duration) {
    const d = Number.isFinite(duration) && duration > 0 ? duration : null;
    const raw = d === null
      ? [5, 0.0001]
      : [Math.min(5, d / 2), Math.min(10, d * 0.75), d / 4, 0.5, 0.0001];
    const out = [];
    raw.forEach((t) => {
      const v = d === null ? t : Math.max(0.0001, Math.min(t, d - 0.05));
      if (!out.some((o) => Math.abs(o - v) < 0.2)) out.push(v);
    });
    return out;
  }

  // A frame that is certainly nothing: no tonal range, and dark. Measured
  // on a 16×16 downsample so it costs nothing. "Dark" is generous (up to
  // ~25% grey) because black rarely arrives as 0: limited-range video
  // decoded as full range lands near 16, and a JPEG of it drifts higher —
  // the black posters in the wild are charcoal, not black. What makes it
  // nothing is the absent range: a dim scene with a face in it has
  // highlights, and is a fine poster. Deliberately NOT frame scoring, and
  // the reason a capture may resolve null for a video: writing nothing
  // means ensureProjectPoster tries again later, where writing black would
  // have made the black permanent.
  function isFlatBlack(canvas) {
    const probe = document.createElement('canvas');
    probe.width = 16;
    probe.height = 16;
    const ctx = probe.getContext('2d');
    ctx.drawImage(canvas, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    let max = 0;
    let min = 255;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (l > max) max = l;
      if (l < min) min = l;
    }
    return max - min < 255 * 0.05 && max < 255 * 0.25;
  }

  // Poster capture. Resolves null for audio (videoWidth 0), decode failure,
  // CORS taint, timeout, or a clip that is flat black at every candidate —
  // null means "no poster", never throws.
  // `options.crossOrigin` asks the server for a CORS-readable copy: the only
  // way a canvas may read a frame of a remote video. Asked on THIS detached
  // element only, never on the live player — a server that does not allow it
  // makes the element fail to load, which here resolves null and costs
  // nothing, and on the player would have stopped the video playing.
  function captureFrameBlob(objectUrl, options) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      if (options && options.crossOrigin === true) video.crossOrigin = 'anonymous';
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
      let candidates = null;
      let index = 0;
      let target = null;       // the seek in flight, or just landed
      let drawnTarget = null;  // each candidate is drawn once: seeked and canplay both arrive
      const seekTo = (t) => {
        target = t;
        try { video.currentTime = t; } catch (e) { done(null); }
      };
      const nextCandidate = () => {
        index += 1;
        if (candidates !== null && index < candidates.length) seekTo(candidates[index]);
        else done(null); // flat black everywhere we looked: no poster is the honest answer
      };
      const tryDraw = () => {
        // never the pre-seek frame: that is frame 1 back by another door
        if (target === null || video.seeking || drawnTarget === target) return;
        if (video.videoWidth <= 0 || video.readyState < 2 /* HAVE_CURRENT_DATA */) return;
        drawnTarget = target;
        const canvas = document.createElement('canvas');
        canvas.width = CAPTURE_WIDTH;
        canvas.height = Math.max(1, Math.round(CAPTURE_WIDTH * video.videoHeight / video.videoWidth));
        try {
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          if (isFlatBlack(canvas)) { nextCandidate(); return; }
          canvas.toBlob((blob) => done(blob), 'image/jpeg', 0.75);
        } catch (e) {
          done(null); // tainted canvas or draw failure
        }
      };
      video.addEventListener('loadedmetadata', () => {
        if (video.videoWidth <= 0) { done(null); return; } // audio: nothing to draw
        candidates = captureCandidates(video.duration);
        seekTo(candidates[0]);
      });
      video.addEventListener('seeked', tryDraw);
      video.addEventListener('canplay', tryDraw);
      video.addEventListener('error', () => done(null));
      video.src = objectUrl;
    });
  }

  // Whether a stored poster is the flat black an earlier capture could
  // save (#582). Decoded once per project per session: a black poster is
  // treated as absent so the capture runs again with the candidates above;
  // if that finds nothing either, the stored one stays.
  const rechecked = new Set();
  async function storedPosterIsFlatBlack(id, file) {
    if (rechecked.has(id)) return false;
    rechecked.add(id);
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close();
      return isFlatBlack(canvas);
    } catch (e) {
      return false;
    }
  }

  // The remote URL a link project plays from, off its library entry — when
  // there is any point asking: an audio link has no frame, and a URL whose
  // server has refused once this session is not asked again. ensureProjectPoster
  // runs on every library change, and without this the intro's mp3 was asked
  // for a cross-origin copy on each one, refused on each one.
  const linkRefused = new Set();
  async function linkUrlFor(id) {
    const lib = window.HyperaudioSave && window.HyperaudioSave.library;
    if (!lib || typeof lib.list !== 'function') return null;
    try {
      const entry = (await lib.list()).find((e) => String(e.id) === String(id));
      if (!entry || !entry.media || entry.media.kind !== 'link') return null;
      if (entry.media.hasVideo === false) return null;   // audio: nothing to capture
      const url = entry.media.url;
      if (typeof url !== 'string' || !/^https?:/i.test(url) || linkRefused.has(url)) return null;
      return url;
    } catch (e) {
      return null;
    }
  }

  let ensureChain = Promise.resolve(); // captures serialize; they're heavy
  function ensureProjectPoster(id) {
    ensureChain = ensureChain.then(async () => {
      if (!id) return;
      const existing = await readPoster(id);
      if (existing !== null && !(await storedPosterIsFlatBlack(id, existing))) return; // once is enough
      const media = await firstMediaFile(id);
      let url;
      let blob;
      if (media !== null) {
        url = URL.createObjectURL(media);
        try {
          blob = await captureFrameBlob(url);
        } finally {
          URL.revokeObjectURL(url);
        }
      } else {
        // A link project stores no file. Its picture, if the server permits
        // a cross-origin read, is captured from the URL itself: the same
        // candidates, the same black-frame refusal, with the CORS request
        // made on the detached copy only. A server that refuses resolves
        // null, and the glyph serves as before.
        const link = await linkUrlFor(id);
        if (link === null) return;
        blob = await captureFrameBlob(link, { crossOrigin: true });
        if (blob === null) linkRefused.add(link);   // refused, or nothing worth keeping: once is enough
      }
      if (blob === null || blob === undefined) return; // audio or uncapturable — the glyph serves
      const s = store();
      if (s === null) return;
      const dir = await s.projectDir(id, false);
      await s.writeFile(dir, POSTER_NAME, blob);
      urlCache.delete(id); // next urlFor sees the fresh file
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

  // The capture's URL if it has been read this session, synchronously: what
  // loadstart needs to cover a project switch with the right picture at once
  // rather than with a glyph the capture then replaces a frame later.
  function cachedUrlFor(id) {
    return urlCache.has(id) ? urlCache.get(id) : null;
  }

  document.addEventListener('hyperaudioLibraryChanged', () => {
    const lib = window.HyperaudioSave && window.HyperaudioSave.library;
    if (lib && typeof lib.currentId === 'function') ensureProjectPoster(lib.currentId());
  });

  window.MediaPosters = Object.freeze({
    ensureProjectPoster, urlFor, cachedUrlFor, captureFrameBlob, captureCandidates, glyphUrl, glyphHue, glyphSeed, glyphFill, glyphIsVideo,
  });
})();

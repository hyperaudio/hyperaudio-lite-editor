/**
 * media-first-frame.js
 * (C) The Hyperaudio Project
 * @version 1.3.14 — last changed in release 1.3.14
 * @license MIT
 *
 * First-frame display for video media (#556). A <video> shows its poster —
 * or nothing — until a frame is decoded, which with preload=metadata never
 * happens on its own: opened video projects sat on the generic demo poster
 * or a black box until played. On metadata, video media drops the generic
 * poster and takes an epsilon seek so the real first frame paints; audio
 * media keeps the poster (better than a black box). The player's
 * aspect-ratio is pinned from the incoming dimensions so the layout stops
 * shifting on project switches. Dimensions can arrive late on some sources
 * (MSE/HLS), so the reveal listens across every event they can appear on.
 *
 * That pin has to SURVIVE the swap to be worth anything (#590): dropping it
 * at loadstart collapsed the player to nothing until the next metadata
 * arrived, and the controls, the Recents panel and the transcript all rode
 * that ~430px jump down and back. The gap is filled by whatever the player
 * was already showing — the outgoing frame, frozen — instead of the markup's
 * poster attribute, which belongs to the intro audio and was never meant to
 * stand in for anyone's project: putting it back at loadstart flashed the
 * hyperaudio wordmark between every pair of projects. What the incoming
 * medium IS gets settled when its metadata says so, not guessed at
 * loadstart.
 *
 * The poster is NEVER removed (#575). Removing it and epsilon-seeking did
 * paint frame 1, but it also moved the element's display mode to "video", and
 * WebKit has no path back: every project opened afterwards painted nothing —
 * a blank box, with the poster attribute present and resolving. Restoring the
 * attribute does not restore the mode, and neither does load(); only a fresh
 * element recovers. Blink is unaffected, so it never showed up in Chrome.
 *
 * What is shown instead is the project's own stored capture, which
 * media-posters.js (#523) already makes for the Recents thumbnail: the same
 * picture the seek was chasing, without the element ever going posterless.
 * Going through MediaPosters.urlFor also honours window.hyperaudioMediaPoster,
 * the embedder seam #567 asks for. Each load carries a token so a capture that
 * arrives late cannot repaint the project that replaced it.
 *
 * Self-contained and removable: no other module depends on this file.
 */
(function firstFrameForVideo() {
  function wire() {
    const player = document.getElementById('hyperplayer');
    if (player === null) { setTimeout(wire, 500); return; }
    const defaultPoster = player.getAttribute('poster');
    // Bumped on every load; an async poster lookup that finishes after the
    // next one has started must stand down rather than repaint it.
    let loadToken = 0;

    // The frame on screen, as a data URL — the stand-in while the next medium
    // loads. Null for audio (nothing to draw) and for cross-origin media,
    // which taints the canvas.
    function freezeFrame() {
      try {
        if (!player.videoWidth) return null;
        const canvas = document.createElement('canvas');
        canvas.width = player.videoWidth;
        canvas.height = player.videoHeight;
        canvas.getContext('2d').drawImage(player, 0, 0);
        return canvas.toDataURL('image/jpeg', 0.7);
      } catch (e) {
        return null;
      }
    }

    player.addEventListener('loadstart', () => {
      // A new medium is loading. The aspect pin STAYS so the box keeps its
      // size, and the picture stays with it: the outgoing frame becomes the
      // poster for the length of the gap. With nothing to freeze — a cold
      // start, or audio, where the poster IS the display — whatever is
      // already showing is left alone, which is the same continuity.
      loadToken += 1;
      const frozen = freezeFrame();
      if (frozen !== null) player.setAttribute('poster', frozen);
    });

    const currentProjectId = () => {
      const lib = window.HyperaudioSave && window.HyperaudioSave.library;
      return lib && typeof lib.currentId === 'function' ? lib.currentId() : null;
    };
    // The library's entry for an id, for the glyph's seed (#618): the colour
    // hashes from the project's created time, which only the entry carries.
    // Resolves the bare id when the library cannot say, so the glyph is
    // still drawn — just seeded per app rather than per file.
    const currentEntry = async (id) => {
      const lib = window.HyperaudioSave && window.HyperaudioSave.library;
      if (!lib || typeof lib.list !== 'function') return id;
      try {
        const entry = (await lib.list()).find((p) => String(p.id) === String(id));
        return entry === undefined ? id : entry;
      } catch (e) {
        return id;
      }
    };

    // The project's own stored frame-1 capture, waiting for it to be made if
    // this is the first visit. ensureProjectPoster is the same serialized,
    // capture-once chain the Recents thumbnails use, so asking again here
    // costs a read when one already exists.
    // waitForCapture: video only. Asking media-posters to MAKE a capture is
    // worth waiting for when there is a frame to grab, and pointless for audio
    // — captureFrameBlob has nothing to draw there and only resolves on its
    // 8s timeout, which left an audio project wearing the previous project's
    // glyph for eight seconds after a switch (#603).
    async function applyStoredPoster(token, waitForCapture) {
      const posters = window.MediaPosters;
      const id = currentProjectId();
      if (!posters || typeof posters.urlFor !== 'function' || id === null) return false;
      try {
        let url = await posters.urlFor(id);
        if (!url && waitForCapture && typeof posters.ensureProjectPoster === 'function') {
          await posters.ensureProjectPoster(id);
          if (token !== loadToken) return false;
          url = await posters.urlFor(id);
        }
        if (token !== loadToken || !url) return false;
        player.setAttribute('poster', url);
        return true;
      } catch (e) {
        return false;
      }
    }

    function reveal() {
      if (player.videoWidth <= 0) return; // audio, or dimensions not known yet
      player.style.aspectRatio = player.videoWidth + ' / ' + player.videoHeight;
      // NO removeAttribute, and no epsilon seek: both drove the element into
      // the display mode WebKit will not leave (#575). The stand-in frame
      // showing right now belongs to the PREVIOUS project, so it is replaced
      // by this one's capture; failing that, the markup's poster is a better
      // answer than another project's picture.
      const token = loadToken;
      applyStoredPoster(token, true).then((applied) => {
        if (applied || token !== loadToken) return;
        const showing = player.getAttribute('poster');
        if (defaultPoster !== null && showing !== null && showing.startsWith('data:')) {
          player.setAttribute('poster', defaultPoster);
        }
      });
    }
    ['loadedmetadata', 'loadeddata', 'resize', 'canplay'].forEach((ev) => {
      player.addEventListener(ev, reveal);
    });

    // Audio has no frame to reveal, so it is settled here instead: release the
    // outgoing video's aspect pin, which would otherwise leave the audio
    // player standing video-tall, then find it a picture.
    //
    // The markup poster is the INTRO audio's artwork (#603), so falling back
    // to it made every audio project wear the same face — branding, shown to
    // someone about a recording they made this morning. The library already
    // draws audio a per-project wave glyph; the player now shows the same one,
    // so a project looks the same wherever you meet it. Order: an embedder's
    // poster still wins, then the glyph, then the markup poster as before, so
    // nothing regresses if the glyph cannot be made.
    player.addEventListener('loadedmetadata', () => {
      if (player.videoWidth > 0) return;
      player.style.aspectRatio = '';
      const token = loadToken;
      applyStoredPoster(token, false).then(async (applied) => {
        if (applied || token !== loadToken) return;
        const posters = window.MediaPosters;
        const id = currentProjectId();
        if (posters && typeof posters.glyphUrl === 'function' && id !== null) {
          const entry = await currentEntry(id);
          if (token !== loadToken) return;   // the library moved on meanwhile
          player.setAttribute('poster', posters.glyphUrl(entry));
          return;
        }
        if (defaultPoster !== null) player.setAttribute('poster', defaultPoster);
      });
    });

    // A project born on this player — a dropped file, a transcription — gets
    // its library entry AFTER its media loads, so the glyph drawn above could
    // only be seeded by the id. Re-seed it when the library changes, and only
    // a glyph: a stored capture or an embedder's poster is never touched here
    // (#618).
    document.addEventListener('hyperaudioLibraryChanged', () => {
      if (player.videoWidth > 0) return;
      const showing = player.getAttribute('poster') || '';
      if (!showing.startsWith('data:image/svg')) return;
      const posters = window.MediaPosters;
      const id = currentProjectId();
      if (!posters || typeof posters.glyphUrl !== 'function' || id === null) return;
      const token = loadToken;
      currentEntry(id).then((entry) => {
        if (token !== loadToken) return;
        const url = posters.glyphUrl(entry);
        if (player.getAttribute('poster') !== url) player.setAttribute('poster', url);
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

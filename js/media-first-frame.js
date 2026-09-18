/**
 * media-first-frame.js
 * (C) The Hyperaudio Project
 * @version 1.3.20 — last changed in release 1.3.20
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

    // Every poster this module writes, recorded with the load it was written
    // for and whether it belongs to THAT medium. The question the handlers
    // below actually need is "is this picture the current medium's?", and only
    // the recorded values answer it: a frozen outgoing frame, a medium's own
    // frame, a project's stored capture and a glyph are all just URLs on the
    // element, and a capture in particular is indistinguishable by sight.
    // `project` is the id a stored capture was fetched for. The library
    // changes before library.currentId() moves on, so a capture fetched during
    // that window belongs to the project the user was on, not the one now
    // owning the medium — and applying it is how the previous recording's
    // picture kept ending up over a new transcription. Recorded, so the next
    // change sees it is not this project's and asks again.
    // `provisional` marks a picture a real capture may still improve on — a
    // glyph, a first frame, a stand-in — which is what lets #619's upgrade
    // keep working. A stored capture is final.
    // What a VIDEO project wears in the player when it has no picture of its
    // own: black. A glyph here was a flash of colour on every switch before
    // the capture landed, and for a link the server will not let a canvas
    // read it was the picture for good; black is what an empty player looks
    // like and is what a frame arrives over. The poster attribute is never
    // removed to get there (#575: WebKit never leaves the display mode a
    // posterless element enters). The film glyph stays for Recents.
    const BLACK_POSTER = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">'
      + '<rect width="640" height="360" fill="#000"/></svg>');
    // The library as last announced, for the one moment — loadstart — that
    // cannot wait for a read: whether the incoming project is audio or video
    // decides between the wave and black.
    const entriesById = new Map();
    const rememberEntries = async () => {
      const lib = window.HyperaudioSave && window.HyperaudioSave.library;
      if (!lib || typeof lib.list !== 'function') return;
      try { (await lib.list()).forEach((e) => entriesById.set(String(e.id), e)); } catch (e) { /* keep what we have */ }
    };
    document.addEventListener('hyperaudioLibraryChanged', rememberEntries);
    rememberEntries();
    const knownVideo = (entry) => !!(entry && entry.media && entry.media.hasVideo === true);
    const knownAudio = (entry) => !!(entry && entry.media && entry.media.hasVideo === false);
    // the cover for a project with no picture: black for video, the wave for
    // audio, black while it is not yet known
    const coverFor = (entry, id) => {
      const posters = window.MediaPosters;
      if (knownAudio(entry) && posters && typeof posters.glyphUrl === 'function') return posters.glyphUrl(entry || id);
      return BLACK_POSTER;
    };

    let applied = { url: null, token: -1, own: false, project: null, provisional: true };
    const setPoster = (url, own, project, provisional) => {
      applied = {
        url,
        token: loadToken,
        own: own === true,
        project: project === undefined ? null : project,
        provisional: provisional !== false,
      };
      player.setAttribute('poster', url);
    };
    // Not this medium's, and not this project's: the frozen frame of the one
    // before it, or a capture fetched for the project that was open a moment
    // ago. Either way it has no business over what is on the player now.
    const isForeign = (showing) => !(
      applied.own === true && applied.token === loadToken && applied.url === showing
      && (applied.project === null || applied.project === currentProjectId())
    );

    player.addEventListener('loadstart', () => {
      // A new medium is loading. The aspect pin STAYS so the box keeps its
      // size, and the picture stays with it: the outgoing frame becomes the
      // poster for the length of the gap. With nothing to freeze — a cold
      // start, or audio, where the poster IS the display — whatever is
      // already showing is left alone, which is the same continuity.
      loadToken += 1;
      // A different project's medium arriving: the picture up is the outgoing
      // project's, and for the length of a slow load that is the wrong
      // project's face over this one's transcript. Cover the gap with this
      // project's own glyph — provisional, so a capture or a frame replaces
      // it the moment either exists. Within one project the outgoing frame
      // still covers the gap, which keeps the continuity a reload had.
      const id = currentProjectId();
      if (id !== null && applied.project !== null && applied.project !== id) {
        const posters = window.MediaPosters;
        // a capture read earlier this session is the answer at once
        const seen = posters && typeof posters.cachedUrlFor === 'function' ? posters.cachedUrlFor(id) : null;
        if (seen !== null) { setPoster(seen, true, id, false); return; }
        setPoster(coverFor(entriesById.get(String(id)) || null, id), true, id);
        return;
      }
      const frozen = freezeFrame();
      // the OUTGOING medium's frame, covering the gap — not this one's
      if (frozen !== null) setPoster(frozen, false);
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
        // arrived late, after a transcription took the screen (#619): the
        // session's project is not what is on the player any more
        if (loaderOwnsScreen()) return false;
        setPoster(url, true, id, false);   // a real capture: nothing improves on it
        return true;
      } catch (e) {
        return false;
      }
    }

    // Whether the transcript loader owns the screen: the medium on the player
    // is a transcription's, and no project owns it yet.
    const loaderOwnsScreen = () => {
      const t = document.getElementById('hypertranscript');
      return t !== null && t.getAttribute('aria-busy') === 'true';
    };
    let ownFrameToken = -1; // the load whose own first frame is already the poster
    let standInUrl = null;  // an object URL this module made for a transcription's stand-in
    const setStandIn = (url) => {
      if (standInUrl !== null) URL.revokeObjectURL(standInUrl);
      standInUrl = url;
      setPoster(url, true);
    };

    function reveal() {
      if (player.videoWidth <= 0) return; // audio, or dimensions not known yet
      hideAudioPoster();                  // video paints its own frames (#629)
      player.style.aspectRatio = player.videoWidth + ' / ' + player.videoHeight;
      // A transcription's medium (#619): the session's project — whose capture the
      // stored-poster pass below would fetch — is still the PREVIOUS one, so
      // its picture was drawn into THIS medium's box: a 16:9 photo
      // letterboxed in a 4:3 frame, corners squared off, until the newborn
      // project's own capture arrived at the end. The medium's own first
      // frame is the honest picture. Drawn once a frame is decodable (the
      // loadeddata / canplay passes land here too), once per load, and with
      // no seek (#575). A frame that cannot be drawn (cross-origin) leaves
      // the stand-in alone, as loadstart does.
      if (loaderOwnsScreen()) {
        if (player.readyState >= 2 && ownFrameToken !== loadToken) {
          const own = freezeFrame();
          if (own !== null) {
            setPoster(own, true);
            ownFrameToken = loadToken;
            // Frame 1 is the likeliest black frame in the clip (#582), so
            // once it is up, ask the capture pipeline — which seeks a
            // detached copy to the 5s mark and refuses flat frames — for a
            // better stand-in. The live player cannot seek without moving
            // the playhead; the copy can. Null (cross-origin, flat all
            // through) keeps frame 1.
            const posters = window.MediaPosters;
            const token = loadToken;
            const src = player.currentSrc || player.src;
            if (posters && typeof posters.captureFrameBlob === 'function' && src) {
              // a remote URL is asked for a CORS-readable copy, on the
              // detached element only; a server that refuses leaves frame 1
              posters.captureFrameBlob(src, { crossOrigin: /^https?:/i.test(src) }).then((blob) => {
                if (blob === null || token !== loadToken || !loaderOwnsScreen()) return;
                setStandIn(URL.createObjectURL(blob));
              }).catch(() => { /* frame 1 stays */ });
            }
          }
        }
        return;
      }
      // NO removeAttribute, and no epsilon seek: both drove the element into
      // the display mode WebKit will not leave (#575). The stand-in frame
      // showing right now belongs to the PREVIOUS project, so it is replaced
      // by this one's capture; failing that, the markup's poster is a better
      // answer than another project's picture.
      const token = loadToken;
      applyStoredPoster(token, true).then(async (upgraded) => {
        if (upgraded || token !== loadToken) return;
        // No capture. What is showing is either this project's own picture —
        // its glyph, put up at loadstart or by the library change — which
        // stays, or a foreign one, which gives way to the glyph. It used to
        // give way to the MARKUP poster whenever it was a data: URL, which
        // painted the logo over the project's own glyph for the length of a
        // slow load, and the logo is branding, not this project's picture
        // (#603).
        const showing = player.getAttribute('poster') || '';
        if (!isForeign(showing)) return;
        setPoster(BLACK_POSTER, true, currentProjectId());
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
    /* ---- The audio poster WebKit stops painting (#629) ---------------------
     * Safari leaves poster display mode the moment playback starts, even for
     * audio, where no frame is coming and the attribute is still set: the
     * player goes to a bare box for the rest of the play, and the element's
     * intrinsic size falls back to 300x150, so the layout jumps with it.
     * Blink keeps the poster, which is why the same page looks right in
     * Chrome. Nothing in the #575 discipline helps — the attribute IS intact.
     *
     * So for audio the same picture is painted a second time, as an <img>
     * BEHIND the player, which WebKit has no reason to stop drawing. Behind,
     * not over, so native captions and the play overlay stay on top
     * (#player-frame carries isolation:isolate, which keeps the negative
     * z-index above the frame's own background). The <img> mirrors the
     * poster attribute, so a stored capture, the glyph, or an embedder's
     * poster all follow it without this having to know which is which.
     * --------------------------------------------------------------------- */
    let audioPosterEl = null;
    function audioPoster() {
      if (audioPosterEl !== null) return audioPosterEl;
      const frame = document.getElementById('player-frame');
      if (frame === null) return null;
      audioPosterEl = document.createElement('img');
      audioPosterEl.id = 'audio-poster';
      audioPosterEl.alt = '';            // decorative: it duplicates the poster
      audioPosterEl.hidden = true;
      // NOT pinned to the picture's aspect: #556 uses the CLEARED pin as the
      // signal that a medium was recognised as audio, and pinning it here
      // breaks that. The duplicate is absolutely positioned in the frame, so
      // it keeps its size whatever the element's intrinsic size does. If a
      // real Safari ever shows the 300x150 collapse the issue describes, it
      // needs a rule that does not take #556's signal away.
      frame.appendChild(audioPosterEl);
      return audioPosterEl;
    }

    function showAudioPoster() {
      const img = audioPoster();
      if (img === null) return;
      const poster = player.getAttribute('poster') || '';
      if (poster === '') { hideAudioPoster(); return; }
      if (img.getAttribute('src') !== poster) img.setAttribute('src', poster);
      img.hidden = false;
    }

    function hideAudioPoster() {
      if (audioPosterEl === null) return;
      audioPosterEl.hidden = true;
      audioPosterEl.removeAttribute('src');
    }

    // Whatever changes the poster — a capture arriving, the glyph re-seeded,
    // an embedder answering late — the duplicate follows it.
    new MutationObserver(() => {
      if (audioPosterEl !== null && !audioPosterEl.hidden) showAudioPoster();
    }).observe(player, { attributes: true, attributeFilter: ['poster'] });

    function settleAudio() {
      if (player.videoWidth > 0) return;
      player.style.aspectRatio = '';
      showAudioPoster();
      const token = loadToken;
      applyStoredPoster(token, false).then(async (applied) => {
        if (applied || token !== loadToken) return;
        const posters = window.MediaPosters;
        const id = currentProjectId();
        if (posters && typeof posters.glyphUrl === 'function' && id !== null) {
          const entry = await currentEntry(id);
          if (token !== loadToken) return;   // the library moved on meanwhile
          setPoster(posters.glyphUrl(entry), true, id);
          return;
        }
        if (defaultPoster !== null) setPoster(defaultPoster, true);
      }).then(() => { if (player.videoWidth === 0) showAudioPoster(); });
    }
    player.addEventListener('loadedmetadata', settleAudio);

    // A project born on this player — a transcription — keeps the medium it
    // was born with, so no load event runs the reveal above, and the stand-in
    // drawn while the loader owned the screen (frame 1: the likeliest black
    // frame in the clip, #582) stayed as the player's poster while the
    // Recents thumbnail showed the real capture. When the library changes
    // and a project owns the medium again, a stand-in gives way to the
    // project's stored capture — waiting for the capture that same change
    // has just set going. A stored capture or an embedder's poster already
    // showing is left alone (#619).
    //
    // A medium that never decodes a frame — a cloud recording still arriving,
    // which is most of them while the transcription runs — leaves the picture
    // frozen at loadstart in place: the PREVIOUS project's. Nothing replaced
    // it afterwards either, because URL media stores no file for the capture
    // pipeline to read, so applyStoredPoster can never answer. The project
    // then wore the last recording's picture for good, while Recents drew its
    // glyph beside it. The glyph is the fallback here too, so the two agree —
    // the same answer settleAudio already gives audio with no capture.
    //
    // Only a picture belonging to ANOTHER medium gives way: this medium's own
    // frame, when it managed to draw one, is the better answer and stays.
    // Not gated on videoWidth: a medium still arriving reports none, which is
    // exactly the case this exists for. Waiting for a capture stays gated on
    // it, because there is nothing to grab without a frame (#603).
    document.addEventListener('hyperaudioLibraryChanged', () => {
      if (loaderOwnsScreen()) return;
      // a real capture for the project that owns the medium: nothing to do
      if (!isForeign(player.getAttribute('poster') || '') && applied.provisional === false) return;
      const token = loadToken;
      applyStoredPoster(token, player.videoWidth > 0).then(async (upgraded) => {
        if (upgraded || token !== loadToken || loaderOwnsScreen()) return;
        const showing = player.getAttribute('poster') || '';
        const id = currentProjectId();
        if (id === null) return;
        // A cover of this project's, put up before the entry knew whether the
        // medium had a picture: black may now be owed a wave, or a wave black.
        // Redraw from the entry as it stands; a frame of the medium's own is
        // not a cover and stays.
        if (!isForeign(showing) && applied.provisional === true && showing.startsWith('data:image/svg')) {
          const entry = await currentEntry(id);
          if (token !== loadToken) return;
          const fresh = player.videoWidth > 0 ? BLACK_POSTER : coverFor(entry, id);
          if (fresh !== showing) setPoster(fresh, true, id);
          return;
        }
        // no capture to be had; a provisional picture of this medium's own is
        // still better than a cover, so only a foreign one is replaced
        if (!isForeign(showing)) return;
        const entry = await currentEntry(id);
        if (token !== loadToken) return;
        setPoster(player.videoWidth > 0 ? BLACK_POSTER : coverFor(entry, id), true, id);
      });
    });

    // A project born on this player — a dropped file, a transcription — gets
    // its library entry AFTER its media loads, so the glyph drawn above could
    // only be seeded by the id. Re-seed it when the library changes, and only
    // a glyph: a stored capture or an embedder's poster is never touched here
    // (#618).
    // ...and the markup poster still showing on audio whose metadata is known
    // is the same gap from the other side (#621): the intro's medium is in the
    // markup and starts loading before any script, so a cached mp3 can
    // report metadata before this module has a listener to hear it.
    document.addEventListener('hyperaudioLibraryChanged', () => {
      // Before metadata a video reports no width and looks like audio: this
      // re-seeded a glyph over a video project's capture for one frame at
      // every switch. settleAudio runs on loadedmetadata and will do this
      // properly once the medium is known.
      if (player.readyState < 1) return;
      if (player.videoWidth > 0) return;
      const showing = player.getAttribute('poster') || '';
      if (showing === defaultPoster) { settleAudio(); return; }
      if (!showing.startsWith('data:image/svg')) return;
      const posters = window.MediaPosters;
      const id = currentProjectId();
      if (!posters || typeof posters.glyphUrl !== 'function' || id === null) return;
      const token = loadToken;
      currentEntry(id).then((entry) => {
        if (token !== loadToken) return;
        const url = posters.glyphUrl(entry);
        if (player.getAttribute('poster') !== url) setPoster(url, true);
      });
    });

    // What the poster is and why, for a bug report from a real session: the
    // state above is closed over and a stale picture cannot be diagnosed from
    // the element alone. hyperaudioPosterDebug() in the console.
    window.hyperaudioPosterDebug = async function hyperaudioPosterDebug() {
      const showing = player.getAttribute('poster') || '';
      const posters = window.MediaPosters;
      const lib = window.HyperaudioSave && window.HyperaudioSave.library;
      const entries = lib && typeof lib.list === 'function' ? await lib.list() : [];
      const projects = [];
      for (const e of entries) {
        let capture = null;
        try { capture = posters && typeof posters.urlFor === 'function' ? await posters.urlFor(e.id, e) : null; } catch (err) { capture = null; }
        projects.push({
          name: e.name,
          current: String(e.id) === String(currentProjectId()),
          showingItsGlyph: !!(posters && posters.glyphUrl && posters.glyphUrl(e) === showing),
          showingItsCapture: capture !== null && capture === showing,
        });
      }
      const meta = document.querySelector('meta[name="version"]');
      const report = {
        version: meta !== null ? meta.content : null,
        poster: showing === '' ? '(none)' : (showing === BLACK_POSTER ? '(black cover)' : showing.slice(0, 40)),
        applied: {
          url: applied.url === null ? null : applied.url.slice(0, 40),
          token: applied.token, own: applied.own, project: applied.project, provisional: applied.provisional,
        },
        loadToken,
        blackCover: showing === BLACK_POSTER,
        loaderOwnsScreen: loaderOwnsScreen(),
        currentProjectId: currentProjectId(),
        player: { readyState: player.readyState, videoWidth: player.videoWidth, src: (player.currentSrc || player.src || '').slice(0, 80) },
        projects,
      };
      console.log(JSON.stringify(report, null, 1));
      return report;
    };

    // Metadata that arrived before this module wired up (a cached medium in
    // the markup, #621): settle it now, as the event would have.
    if (player.readyState >= 1) {
      if (player.videoWidth > 0) reveal(); else settleAudio();
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

/**
 * media-first-frame.js
 * (C) The Hyperaudio Project
 * @version 1.3.9 — last changed in release 1.3.9
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
 * Self-contained and removable: no other module depends on this file.
 */
(function firstFrameForVideo() {
  function wire() {
    const player = document.getElementById('hyperplayer');
    if (player === null) { setTimeout(wire, 500); return; }
    const defaultPoster = player.getAttribute('poster');
    let nudged = false;

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
      nudged = false;
      const frozen = freezeFrame();
      if (frozen !== null) player.setAttribute('poster', frozen);
    });

    function reveal() {
      if (player.videoWidth <= 0) return; // audio, or dimensions not known yet
      player.style.aspectRatio = player.videoWidth + ' / ' + player.videoHeight;
      if (player.getAttribute('poster') !== null) player.removeAttribute('poster');
      if (!nudged && player.paused && player.currentTime === 0) {
        nudged = true;
        try { player.currentTime = 0.0001; } catch (e) { /* decoder not ready — harmless */ }
      }
    }
    ['loadedmetadata', 'loadeddata', 'resize', 'canplay'].forEach((ev) => {
      player.addEventListener(ev, reveal);
    });

    // Audio has no frame to reveal, so it is settled here instead: release the
    // outgoing video's aspect pin, which would otherwise leave the audio
    // player standing video-tall, and put the markup's poster back — for
    // audio there is nothing else to show. Note this is the INTRO audio's
    // artwork, so a user's own audio project wears hyperaudio branding; that
    // predates #590 and is left as it was rather than changed in passing.
    player.addEventListener('loadedmetadata', () => {
      if (player.videoWidth > 0) return;
      player.style.aspectRatio = '';
      if (defaultPoster !== null) player.setAttribute('poster', defaultPoster);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

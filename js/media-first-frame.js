/**
 * media-first-frame.js
 * (C) The Hyperaudio Project
 * @version 1.3.3 — new in 1.3.x
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
 * Self-contained and removable: no other module depends on this file.
 */
(function firstFrameForVideo() {
  function wire() {
    const player = document.getElementById('hyperplayer');
    if (player === null) { setTimeout(wire, 500); return; }
    const defaultPoster = player.getAttribute('poster');
    let nudged = false;

    player.addEventListener('loadstart', () => {
      // A new medium is loading: back to the generic poster until it proves
      // itself video; a previous video's aspect pin must not squeeze it.
      nudged = false;
      if (defaultPoster !== null && player.getAttribute('poster') === null) {
        player.setAttribute('poster', defaultPoster);
      }
      player.style.aspectRatio = '';
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
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

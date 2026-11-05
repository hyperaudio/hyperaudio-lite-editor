/*
 * media-unplayable.js — says so when the browser cannot play the media (#740)
 *
 * @version 1.3.44 — last changed in release 1.3.44
 * @license AGPL-3.0-only
 *
 * Safari refuses an H.264 MP4 whose sample entry is avc3 (parameter sets
 * carried in-band, common in broadcast downloads). The transcript loads and
 * the words are all there, but play() rejects with NotSupportedError, the
 * duration stays NaN, and nothing said why. This listens for the player's
 * error event and for a rejected play() (editor-main's togglePlay reports
 * one through the hyperaudioPlayRejected event) and puts a line under the
 * picture. For an http(s) source a HEAD request tells a host that cannot be
 * reached from a format that cannot be played. The line goes as soon as the
 * player loads something else. Remove this file and the page behaves as
 * before, with nothing said.
 */
(function () {
  'use strict';

  const player = document.getElementById('hyperplayer');
  const frame = document.getElementById('player-frame');
  if (player === null || frame === null) return;

  const FORMAT = 'This browser can’t play this media’s format. The transcript still works. The media plays in Chrome or Firefox, or after converting it.';
  const UNREACHABLE = 'The media could not be loaded from its link. The transcript still works.';

  let notice = null;
  let shownFor = '';

  const sourceOf = () => player.getAttribute('src') || '';
  // an HLS stream plays through hls.js, whose own errors are its own affair
  const isStream = () => typeof player.dataset.mediaRef === 'string' && player.dataset.mediaRef !== '';

  function show(text) {
    if (notice === null) {
      notice = document.createElement('div');
      notice.id = 'media-unplayable';
      notice.setAttribute('role', 'alert');
      frame.appendChild(notice);
    }
    notice.textContent = text;
  }

  function clear() {
    if (notice !== null) notice.remove();
    notice = null;
    shownFor = '';
  }

  async function report() {
    const src = sourceOf();
    if (src === '' || isStream() || shownFor === src) return;
    shownFor = src;
    let text = FORMAT;
    if (/^https?:/i.test(src)) {
      const reachable = await fetch(src, { method: 'HEAD', mode: 'no-cors' }).then(() => true, () => false);
      if (!reachable) text = UNREACHABLE;
    }
    if (sourceOf() !== src) return; // the player moved on meanwhile
    show(text);
  }

  player.addEventListener('error', () => {
    const err = player.error;
    if (!err) return;
    if (err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
      || err.code === MediaError.MEDIA_ERR_DECODE
      || err.code === MediaError.MEDIA_ERR_NETWORK) report();
  });
  document.addEventListener('hyperaudioPlayRejected', (e) => {
    const name = e.detail && e.detail.name;
    if (name === 'NotSupportedError') report();
  });
  // the next source, whatever it is, starts clean
  player.addEventListener('emptied', clear);
  player.addEventListener('loadstart', () => { if (sourceOf() !== shownFor) clear(); });
  player.addEventListener('loadedmetadata', clear);
})();

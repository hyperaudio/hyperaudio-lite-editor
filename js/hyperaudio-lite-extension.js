/*! (C) The Hyperaudio Project. MIT @license: en.wikipedia.org/wiki/MIT_License. */

/*
 * A FORK, not a vendored copy — do not overwrite this from upstream (#495).
 *
 * It began as hyperaudio-lite's extension and has since diverged substantially:
 * ours carries the editor's search-form wiring and playback-rate controls, which
 * upstream has no notion of, and its search predates upstream's search-mark
 * rewrite. It also carries its own ?v= in index.html rather than tracking the
 * library's version.
 *
 * Of the four files that look vendored from hyperaudio-lite, only
 * js/hyperaudio-lite.js and js/caption.js genuinely are (both byte-identical to
 * upstream v2.6.4 and safe to replace). css/hyperaudio-lite-player.css was
 * returned to byte-identical in #495, with the editor's two deviations moved
 * into css/hyperaudio-lite-editor.css. This file is the one real fork.
 */

'use strict';
// Example wrapper for hyperaudio-lite with search and playbackRate included

let searchForm = document.getElementById('searchForm');

if (searchForm) {
  searchForm.addEventListener('submit', function(event){
    searchPhrase(document.getElementById('search').value);
    event.preventDefault();
  }, false);
}

document.querySelector('#search-box').addEventListener("keyup", (event) => {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  searchPhrase(document.querySelector('#search-box').value);
});


// searchPhrase: marks every match of the search box's query in the
// transcript. What counts as a match lives in js/search-match.js (#395) —
// what you type must be there, what you don't type is ignored — shared with
// find-replace.js's one-span phrase pass. A phrase is matched one word per
// consecutive [data-m] span, and in each span only the matched characters are
// wrapped in <mark class="search-mark">, so punctuation around a word stays
// outside the mark.
const clearPreviousSearch = () => {
  document.querySelectorAll('mark.search-mark').forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent));
  });
  document.querySelectorAll('.search-match').forEach((el) => {
    el.classList.remove('search-match');
    el.normalize(); // merge adjacent text nodes left behind by the unwrap
  });
};

// Wrap `span`'s text in [start, end) with <mark class="search-mark">.
const highlightRange = (span, range) => {
  const original = span.textContent;
  const before = original.slice(0, range[0]);
  const hit = original.slice(range[0], range[1]);
  const after = original.slice(range[1]);
  span.textContent = '';
  if (before) span.append(before);
  const mark = document.createElement('mark');
  mark.className = 'search-mark';
  mark.textContent = hit;
  span.append(mark);
  if (after) span.append(after);
};

const searchPhrase = (phrase) => {
  const spans = document.querySelectorAll('[data-m]');
  if (!spans.length) return;

  clearPreviousSearch();

  const matcher = window.HyperaudioSearchMatch;
  const parsed = matcher ? matcher.parseQuery(phrase) : null;
  if (parsed === null) return;
  const n = parsed.words.length;

  const texts = [...spans].map((span) => span.textContent);
  for (let i = 0; i <= spans.length - n; i++) {
    const ranges = matcher.matchAcross(texts.slice(i, i + n), parsed);
    if (ranges === null) continue;
    ranges.forEach((range, j) => {
      const span = spans[i + j];
      span.classList.add('search-match');
      highlightRange(span, range);
    });
  }
};

const playbackRateCtrl = document.getElementById('pbr');
const currentPlaybackRate = document.getElementById('currentPbr');

if (playbackRateCtrl !== null) {
  playbackRateCtrl.addEventListener('input', function(){
    currentPlaybackRate.value = playbackRateCtrl.value;
    hyperplayer.playbackRate = playbackRateCtrl.value;
  },false);
}

if (currentPlaybackRate !== null) {
  currentPlaybackRate.addEventListener('change', function(){
    playbackRateCtrl.value = currentPlaybackRate.value;
    hyperplayer.playbackRate = playbackRateCtrl.value;
  },false);
}
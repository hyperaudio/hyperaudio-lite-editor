/*! (C) The Hyperaudio Project. MIT @license: en.wikipedia.org/wiki/MIT_License. */

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


// searchPhrase + helpers ported verbatim from hyperaudio-lite v2.5.1's
// extension. Walks consecutive [data-m] spans for multi-word phrases; for each
// matching span it wraps just the matched substring in a <mark class="search-mark">
// so only the searched characters are highlighted, not the whole word. Matching
// is substring-based, so word fragments are found as you type.
const SEARCH_PUNCT = /[.,\-\/#!$%\^&\*;:{}=_`~()\?\s]/g;
const normalise = (text) => text.toLowerCase().replace(SEARCH_PUNCT, '');

const clearPreviousSearch = () => {
  document.querySelectorAll('mark.search-mark').forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent));
  });
  document.querySelectorAll('.search-match').forEach((el) => {
    el.classList.remove('search-match');
    el.normalize(); // merge adjacent text nodes left behind by the unwrap
  });
};

// Wrap the first occurrence of `needle` (case-insensitive) inside `span`'s
// text with <mark class="search-mark">. Punctuation stays outside the mark.
const highlightSubstring = (span, needle) => {
  const original = span.textContent;
  const idx = original.toLowerCase().indexOf(needle);
  if (idx < 0) return;
  const before = original.slice(0, idx);
  const hit = original.slice(idx, idx + needle.length);
  const after = original.slice(idx + needle.length);
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

  const needles = phrase
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(SEARCH_PUNCT, ''))
    .filter(Boolean);
  if (!needles.length) return;

  const lastStart = spans.length - needles.length;
  for (let i = 0; i <= lastStart; i++) {
    const hit = needles.every((needle, j) =>
      normalise(spans[i + j].textContent).includes(needle)
    );
    if (!hit) continue;
    needles.forEach((needle, j) => {
      const span = spans[i + j];
      span.classList.add('search-match');
      highlightSubstring(span, needle);
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
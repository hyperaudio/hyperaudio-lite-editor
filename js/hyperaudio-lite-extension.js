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


let searchPhrase = function (phrase) {
	
  let htmlWords = document.querySelectorAll('[data-m]');
  let htmlWordsLen = htmlWords.length;
	
  let phraseWords = phrase.split(" ");
  let phraseWordsLen = phraseWords.length;
  let matchedTimes = [];

  // clear matched times
  let searchMatched = document.querySelectorAll('.search-match');

  searchMatched.forEach((match) => {
    match.classList.remove('search-match');
  });

  for (let i = 0; i < htmlWordsLen; i++) {
    let numWordsMatched = 0;
    let potentiallyMatched = [];

    for (let j = 0; j < phraseWordsLen; j++) {
      let wordIndex = i + numWordsMatched;

      if (wordIndex >= htmlWordsLen) {
        break;
      }

      // regex removes punctuation - NB for htmlWords case we also remove the space

      if (phraseWords[j].toLowerCase() == htmlWords[wordIndex].innerHTML.toLowerCase().replace(/[\.,-\/#!$%\^&\*;:{}=\-_`~()\? ]/g,"")) {
        potentiallyMatched.push(htmlWords[wordIndex].getAttribute('data-m'));
        numWordsMatched++;
      } else {
        break;
      }

      // if the num of words matched equal the search phrase we have a winner!
      if (numWordsMatched >= phraseWordsLen) {
        matchedTimes = matchedTimes.concat(potentiallyMatched);
      }
    }
  }

  // display
  matchedTimes.forEach(matchedTime => {
    document.querySelectorAll("[data-m='"+matchedTime+"']")[0].classList.add("search-match");
  });
}

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
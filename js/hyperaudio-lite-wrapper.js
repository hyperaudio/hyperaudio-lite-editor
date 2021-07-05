/*! (C) The Hyperaudio Project. AGPL 3.0 @license: https://www.gnu.org/licenses/agpl-3.0.en.html */
/*! Hyperaudio Lite Editor - Version 0.0.1 */

/*!  Hyperaudio Lite Editor's source code is provided under a dual license model.

Commercial license
------------------

If you want to use Hyperaudio Lite Editor to develop commercial sites, tools, and applications, the Commercial License is the appropriate license. With this option, your source code is kept proprietary. To enquire about a Hyperaudio Lite Editor Commercial License please contact info@hyperaud.io

Open source license
-------------------

If you are creating an open source application under a license compatible with the GNU Affero GPL license v3, you may use Hyperaudio Lite Editor under the terms of the AGPL-3.0 License.
*/


'use strict';
// Example wrapper for hyperaudio-lite with search and playbackRate included

var searchForm = document.getElementById('searchForm');

if (searchForm) {
  if(searchForm.addEventListener){ //Modern browsers
    searchForm.addEventListener('submit', function(event){
      searchPhrase(document.getElementById('search').value);
      event.preventDefault();
    }, false);
  }else if(searchForm.attachEvent){ //Old IE
    searchForm.attachEvent('onsubmit', function(event){
      searchPhrase(document.getElementById('search').value);
      event.preventDefault();
    });
  }
}

var htmlWords, htmlWordsLen;

htmlWords = document.querySelectorAll('[data-m]');
htmlWordsLen = htmlWords.length;

var searchPhrase = function (phrase) {

  var phraseWords = phrase.split(" ");
  var phraseWordsLen = phraseWords.length;
  var matchedTimes = [];

  // clear matched times

  var searchMatched = document.querySelectorAll('.search-match');
  var searchMatchedLen = searchMatched.length;

  for (var l = 0; l < searchMatchedLen; l++) {
    searchMatched[l].classList.remove('search-match');
  }

  for (var i = 0; i < htmlWordsLen; i++) {

    var numWordsMatched = 0;
    var potentiallyMatched = [];

    for (var j = 0; j < phraseWordsLen; j++) {

      var wordIndex = i + numWordsMatched;

      if (wordIndex >= htmlWordsLen) {
        break;
      }

      // regex removes punctuation - NB for htmlWords case we also remove the space

      if (phraseWords[j].toLowerCase() == htmlWords[wordIndex].innerHTML.toLowerCase().replace(/[\.,-\/#!$%\^&\*;:{}=\-_`~() ]/g,"")) {
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
  var matchedTimesLen = matchedTimes.length;

  // only match the first word with that time (assuming times are unique)
  for (var k = 0; k < matchedTimesLen; k++) {
    document.querySelectorAll("[data-m='"+matchedTimes[k]+"']")[0].classList.add("search-match");
  }
}

window.onload = function() {

  // playbackRate listener
	var p = document.getElementById('pbr');
	var cp = document.getElementById('currentPbr');

  if (p !== null) {
    p.addEventListener('input', function(){
      cp.innerHTML = p.value;
      hyperplayer.playbackRate = p.value;
    },false);
  }
}


/* Extracted verbatim from index.html (#334) — loaded as a classic script in the same document order. */

    console.log("version 3");

  // Populates the Transcription section of the info modal. Called by the
  // transcription modules (Whisper, Deepgram) when a transcription completes.
  function setTranscriptionInfo(info) {
    const container = document.getElementById("transcription-info");
    if (container === null) {
      return;
    }
    const rows = [];
    if (info.service) rows.push(["Service", info.service]);
    if (info.model) rows.push(["Model", info.model]);
    if (info.language) rows.push(["Language", info.language]);
    if (info.device) rows.push(["Processing", info.device]);
    if (typeof info.seconds === "number") {
      const minutes = Math.floor(info.seconds / 60);
      const seconds = Math.round(info.seconds % 60);
      rows.push(["Time taken", minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`]);
    }
    container.innerHTML = rows.map(([label, value]) => `<p><strong>${label}:</strong> ${value}</p>`).join("");
  }

  // While a transcription is in flight the transcript container holds loader
  // markup, not a transcript – typing into it would be silently destroyed
  // when the result lands. Transcription modules call this around their work.
  function setTranscriptBusy(busy) {
    const transcript = document.getElementById("hypertranscript");
    if (transcript === null) {
      return;
    }
    transcript.setAttribute("contenteditable", String(!busy));
    if (busy) {
      transcript.setAttribute("aria-busy", "true");
    } else {
      transcript.removeAttribute("aria-busy");
    }
  }


  let updateCaptionsFromTranscript = true;
  let captionMode = false; // used to detect whether we need to sanitise amongst other things
  let transcriptRequiresInit = false; // to know whether a transcript has been loaded while in captionMode and so not initialised

  let alertOkBtn = document.querySelector('#captionsource-alert-ok');

  alertOkBtn.addEventListener('click', function() {
    document.querySelector('#captionsource-alert').style.visibility = "hidden";
  });

  let alertCancelBtn = document.querySelector('#captionsource-alert-cancel');

  alertCancelBtn.addEventListener('click', function() {
    document.querySelector('#captionsource-alert').style.visibility = "hidden";
    localStorage.setItem("noCaptionAlert", "true");
  });

  let editableDiv = document.querySelector('#hypertranscript');

  editableDiv.addEventListener("paste", function(e) {
    e.preventDefault();
    var text = e.clipboardData.getData("text/plain");
    text.replaceAll("&nbsp;", " ");
    document.execCommand("insertHTML", false, text);
  });

  window.document.addEventListener('hyperaudioInit', hyperaudio, false);
  window.document.addEventListener('hyperaudioGenerateCaptionsFromTranscript', hyperaudioGenerateCaptionsFromTranscript, false);
  window.document.addEventListener('hyperaudioTranscriptLoaded', updateInteractiveTranscriptDownloadLink, false);

  let hyperaudioTemplate = "";

  fetch('hyperaudio-template.html')
  .then(function(response) {
      // When the page is loaded convert it to text
      return response.text()
  })
  .then(function(html) {
    hyperaudioTemplate = html;
  })
  .catch(function(err) {
      console.log('Failed to fetch page: ', err);
  });

  /* ----------------------------------------------------------- */

  let transcriptCache = null;
  let captionCache = null;

  // A new transcript was just created with no captions of its own
  // (transcribe / JSON import / SRT-VTT import) — discard any cached caption
  // editor so the next entry rebuilds from the fresh transcript. Caption
  // edits otherwise persist; localStorage load manages its own cache.
  window.document.addEventListener('hyperaudioInit', () => { captionCache = null; }, false);

  document.querySelector('#caption-editor-btn').addEventListener('click', (e) => {
    let holder = document.querySelector('.transcript-holder');
    transcriptCache = holder.cloneNode(true);
    captionMode = true;
    hyperaudioGenerateCaptionsFromTranscript();
    document.querySelector('#caption-editor-btn').disabled = true;
    document.querySelector('#transcript-editor-btn').disabled = false;
  });

  document.querySelector('#transcript-editor-btn').addEventListener('click', (e) => {
    restoreTranscript();
    captionMode = false;
    if (transcriptRequiresInit === true) {
      hyperaudio();
      transcriptRequiresInit = false;
    }
    
    document.querySelector('#caption-editor-btn').disabled = false;
    document.querySelector('#transcript-editor-btn').disabled = true;
  });


  /* ----------------------------------------------------------- */

  function hyperaudio() {
    const minimizedMode = false;
    const autoScroll = true;
    const doubleClick = true;
    const webMonetization = false;
    const playOnClick = false;

    const hyperaudioInstance = new HyperaudioLite("hypertranscript", "hyperplayer", minimizedMode, autoScroll, doubleClick, webMonetization, playOnClick);

    // Patch for #294: if the library's polling chain runs while wordArr
    // still references a span deleted by an in-progress edit, the original
    // throws on word.n.parentNode.classList and the chain dies silently.
    // Strip detached entries before delegating — the next debounced
    // refreshHyperaudioInstance will rebuild wordArr from the live DOM.
    const originalUpdateVisualState = hyperaudioInstance.updateTranscriptVisualState.bind(hyperaudioInstance);
    hyperaudioInstance.updateTranscriptVisualState = function (...args) {
      if (hyperaudioInstance.wordArr) {
        const live = hyperaudioInstance.wordArr.filter(w => w.n && w.n.parentNode);
        if (live.length !== hyperaudioInstance.wordArr.length) {
          hyperaudioInstance.wordArr = live;
        }
      }
      // forward all args (e.g. the second "force" flag the library passes on seek)
      return originalUpdateVisualState(...args);
    };

    window.hyperaudioInstance = hyperaudioInstance;

    // Autoscroll target: the element that actually scrolls is .transcript-holder,
    // not #hypertranscript (the library's default scrollContainer, which is
    // absolutely positioned and doesn't scroll here).
    const scrollHolder = document.querySelector('.transcript-holder');
    if (scrollHolder !== null) {
      hyperaudioInstance.scrollContainer = scrollHolder;
    }

    // The library scrolls the active paragraph flush to the top of the scroll
    // container, which tucks it under the navbar. Override scrollToParagraph to
    // leave a small gap at the top. (Stopgap until hyperaudio-lite supports a
    // configurable scroll offset.)
    const SCROLL_TOP_GAP = 24;
    hyperaudioInstance.scrollToParagraph = function (currentParentElementIndex, index) {
      if (currentParentElementIndex === this.parentElementIndex) {
        return;
      }
      this.parentElementIndex = currentParentElementIndex;
      if (!this.autoscroll) {
        return;
      }
      const paragraph = this.parentElements[currentParentElementIndex];
      if (!paragraph) {
        return;
      }
      const containerRect = this.scrollContainer.getBoundingClientRect();
      const paragraphRect = paragraph.getBoundingClientRect();
      const target = this.scrollContainer.scrollTop + (paragraphRect.top - containerRect.top) - SCROLL_TOP_GAP;
      this.smoothScrollTo(this.scrollContainer, Math.max(0, target), 800);
    };

    // Pause autoscroll while the user is actively typing so it doesn't yank the
    // view mid-edit; resume shortly after. Uses 'input' (content changes) so
    // clicking a word to seek still autoscrolls. Attach once per transcript node.
    const transcriptEl = document.querySelector('#hypertranscript');
    if (transcriptEl !== null && transcriptEl.dataset.autoscrollPause !== '1') {
      transcriptEl.dataset.autoscrollPause = '1';
      let typingResume = null;
      transcriptEl.addEventListener('input', () => {
        const hla = window.hyperaudioInstance;
        if (hla && typeof hla.pauseAutoscroll === 'function') {
          hla.pauseAutoscroll();
        }
        clearTimeout(typingResume);
        typingResume = setTimeout(() => {
          const inst = window.hyperaudioInstance;
          if (inst && typeof inst.resumeAutoscroll === 'function') {
            inst.resumeAutoscroll();
          }
        }, 1500);
      });
    }

    const sanitisationCheck = function () {

      let time = 0;
      resetTimer();
      window.onload = resetTimer;
      document.onkeyup = resetTimer;
      document.ontouchend = resetTimer;

      let rootnode = document.querySelector("#hypertranscript");
      let sourceMedia = document.querySelector("#hyperplayer").src;
      let track = document.querySelector('#hyperplayer-vtt');

      function sanitise() {
        let d = new Date();
        let starttime = d.getTime();

        // the container only holds a transcript when there are timed spans –
        // during transcription it holds loader or error markup whose text
        // nodes have no span siblings, and walking those used to throw
        if (rootnode.querySelector("span[data-m]") === null) {
          return;
        }

        // check that transcript has the focus

        // check for focus
        let isTranscriptFocused = false;
        let isCaptionEditorFocused = false;


        if (document.activeElement === rootnode) {
          isTranscriptFocused = true;
        }


        let walker = document.createTreeWalker(rootnode, NodeFilter.SHOW_TEXT, null, false);

        while (walker.nextNode()) {

          if (walker.currentNode.textContent.replaceAll('\n', '').trim().length > 0
              && walker.currentNode.parentElement.tagName !== "SPAN") {

            // if previousSibling is a span, add the textContent of currentNode to it
            if (walker.currentNode.previousSibling !== null && walker.currentNode.previousSibling.tagName === "SPAN") {
              walker.currentNode.previousSibling.textContent += walker.currentNode.textContent;
            } else if (walker.currentNode.nextSibling !== null) {
              // assume nextSibling is a span for now and add textContent of currentNode to that
              walker.currentNode.nextSibling.textContent += walker.currentNode.textContent;
            } else {
              // orphan text node with no siblings at all – leave it alone
              continue;
            }

            // remove currentNode as we've merged its contents
            //walker.currentNode.parentNode.removeChild(walker.currentNode);
            walker.currentNode.textContent = "";
          }
        }

        // look for speakers and break them out into their own spans

        walker = document.createTreeWalker(rootnode, NodeFilter.SHOW_TEXT, null, false);

        while (walker.nextNode()) {
          if (walker.currentNode.textContent.replaceAll('\n', '').replaceAll('  ', ' ').trim().length > 0
              && walker.currentNode.parentElement.tagName === "SPAN" && walker.currentNode.textContent.includes('[') && walker.currentNode.textContent.includes(']')) {

            // if previousSibling is a span, add the textContent of currentNode to it
            if (walker.currentNode.textContent.trim().startsWith('[') === false || walker.currentNode.textContent.trim().endsWith(']') === false) {
             

              //look for text in square brackets
              const regex = / *\[[^\]]*]/g;
              const found = walker.currentNode.textContent.match(regex);

              let startsWithSpeaker = false;
              if (walker.currentNode.textContent.trim().startsWith('[') === true){
                startsWithSpeaker = true;
              }

              walker.currentNode.textContent = walker.currentNode.textContent.replace(regex, '');

              let span = document.createElement("span");
              span.textContent = found + ' ';

              if (span.textContent.includes('[') && span.textContent.includes(']')) {
                span.classList.add("speaker");
                closedSpeaker = false;
              }

              // add the classes of the current node
              span.classList.add(...walker.currentNode.parentNode.classList);
              //DOMTokenList.prototype.add.apply(span.classList, walker.currentNode.parentNode.classList);

              span.setAttribute("data-d","0");

              if (startsWithSpeaker === true) {
                span.setAttribute("data-m",walker.currentNode.parentNode.getAttribute("data-m"));
                walker.currentNode.parentNode.before(span);
              } else {
                let nextStart = walker.currentNode.parentNode.nextElementSibling.getAttribute("data-m");
                span.setAttribute("data-m",nextStart);
                let newSpan = document.createElement("span");
                newSpan.setAttribute("data-m",nextStart);

                newSpan.innerHTML = "&nbsp;";
                walker.currentNode.parentNode.after(span);
                span.after(newSpan);

                // set the cursor
                const range = document.createRange();
                const sel = window.getSelection();
                range.setStartBefore(newSpan.nextElementSibling);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
              }
            }
          }
        }

        let hypertranscript = rootnode.innerHTML.replace(/ class=".*?"/g, '');
        document.querySelector('#download-html').setAttribute('href', 'data:text/html,'+encodeURIComponent(hypertranscript));
        updateInteractiveTranscriptDownloadLink();

        if (isTranscriptFocused === true && updateCaptionsFromTranscript === true) {
          const words = document.querySelectorAll("[data-m]");
          hyperaudioInstance.wordArr = hyperaudioInstance.createWordArray(words);
          hyperaudioInstance.parentElements = hyperaudioInstance.transcript.getElementsByTagName(hyperaudioInstance.parentTag);

          if (hyperaudioInstance.currentTime !== undefined) {
            hyperaudioInstance.updateTranscriptVisualState(hyperaudioInstance.currentTime);
          }

          /*let hypertranscript = rootnode.innerHTML.replace(/ class=".*?"/g, '');
          document.querySelector('#download-html').setAttribute('href', 'data:text/html,'+encodeURIComponent(hypertranscript));*/

          generateCaptionsFromTranscript(hypertranscript, sourceMedia, track);
          const cap2 = caption();
          let subs = cap2.init("hypertranscript", "hyperplayer", '37' , '21'); // transcript Id, player Id, max chars, min chars for caption line
          //populateCaptionEditor(subs.data);
        }

        if (isCaptionEditorFocused === true && updateCaptionsFromTranscript === false) {
          generateCaptionsFromCaptionEditor();
        }

        d = new Date();
        //console.log("sanitising took "+(d.getTime() - starttime)+"ms");
      }

      function resetTimer() {
        clearTimeout(time);
        if (captionMode !== true) {
          time = setTimeout(sanitise, 1000);
        }
      }

      //longpress to set playhead on mobile

      function longPress(element, callback) {
        let pressTimer;
        element.addEventListener("touchstart", function(e) {
          pressTimer = setTimeout(function() {
            callback(e);
          }, 2000);
        });
        element.addEventListener("touchend", function(e) {
          clearTimeout(pressTimer);
        });
      }

      longPress(rootnode, function(e) {
        const startTime = e.target.getAttribute('data-m');
        if (startTime !== null) {
          e.target.classList.add("active");
          hyperaudioInstance.myPlayer.setTime(startTime/1000);
          hyperaudioInstance.setPlayHead(e);
          hyperaudioInstance.checkPlayHead();
        }
      });

    };

    sanitisationCheck();

    const videoElement = document.querySelector("#hyperplayer");
    let sidebarOpen = true;

    document.querySelector('#sidebar-toggle').addEventListener('click', (e) => {

      if (sidebarOpen === true) {
        document.querySelector('.holder').style.left = 0;
        document.querySelector('.main-panel').style.left = 0;
        document.querySelector('.transcript-holder').style.left = 0;
        document.querySelector('#sidebar-close-icon').style.display = "none";
        document.querySelector('#sidebar-open-icon').style.display = "block";
        sidebarOpen = false;
      } else {
        document.querySelector('.holder').style.left = "400px";
        document.querySelector('.main-panel').style.left = "400px";
        document.querySelector('.transcript-holder').style.left = "400px";
        document.querySelector('#sidebar-close-icon').style.display = "block";
        document.querySelector('#sidebar-open-icon').style.display = "none";
        sidebarOpen = true;
      }

      if(
        document.pictureInPictureEnabled &&
        !videoElement.disablePictureInPicture) {
        try {
          if (sidebarOpen === false) {
            videoElement.requestPictureInPicture();
          } else {
            document.exitPictureInPicture();
          }
        } catch(err) {
            console.error(err);
        }
      }
    });
    
    let showSpeakers = document.querySelector('#show-speakers');

    showSpeakers.addEventListener('change', function(e) {
      let speakers = document.querySelectorAll('.speaker');
      if (showSpeakers.checked === true) {
        speakers.forEach((speaker) => {
          //speaker.style.display = "inline";
          speaker.removeAttribute("style");
        });
      } else {
        speakers.forEach((speaker) => {
          speaker.style.display = "none";
        });
      }
    });
  }

  if (window.matchMedia("(max-width: 480px)").matches === true){
    let elem = document.querySelector("#hyperplayer");

    // Create a copy of it
    let clone = elem.cloneNode(true);
    
    clone.style.width = "100%";
    clone.style.paddingTop = "72px";

    // Inject it into the DOM

    document.querySelector('.transcript-holder').prepend(clone);
    elem.remove();
  }

  hyperaudio();

  function hyperaudioGenerateCaptionsFromTranscript() {
    let sourceMedia = document.querySelector("#hyperplayer").src;
    let track = document.querySelector('#hyperplayer-vtt');

    populateCaptionEditor(generateCaptionsFromTranscript(getTranscriptData(), sourceMedia, track));
  }

  function generateCaptionsFromTranscript(hypertranscript, sourceMedia, track) {
    const cap1 = caption();
    let subs = null;
    
    if (captionMode === true) {
      subs = cap1.init("hypertranscript", "hyperplayer", '37' , '21', null, null, transcriptCache); 
    } else {
      subs = cap1.init("hypertranscript", "hyperplayer", '37' , '21');
    }

    document.querySelector('#download-vtt').setAttribute('href', 'data:text/vtt,'+encodeURIComponent(subs.vtt));
    document.querySelector('#download-srt').setAttribute('href', 'data:text/srt,'+encodeURIComponent(subs.srt));

    track.kind = "captions";
    //track.label = "English";
    //track.srclang = "en";
    track.src = "data:text/vtt,"+encodeURIComponent(subs.vtt);

    document
      .querySelector("#download-hypertranscript")
      .setAttribute(
        "href",
        "data:text/html," +
          encodeURIComponent(
            hyperaudioTemplate
              .replace("{hypertranscript}", hypertranscript)
              .replace("{sourcemedia}", sourceMedia)
              .replace("{sourcevtt}", track.src)
          )
      );

    // check to see if it's an mp3 or m4a, in which case we don't display captions
    let extension = document.querySelector('#hyperplayer').src.split('.').pop();
    if (extension === "mp3" || extension === "m4a") {
      document.querySelector('#hyperplayer').textTracks[0].mode = "hidden";
    } else {
      document.querySelector('#hyperplayer').textTracks[0].mode = "showing";
    }
    return subs.data;
  }

  function updateInteractiveTranscriptDownloadLink() {

    // m4a ?
    //let isAudio = document.querySelector('#hyperplayer').src.split('.').pop() === "mp3";

    document
    .querySelector("#download-hypertranscript")
    .setAttribute(
      "href",
      "data:text/html," +
        encodeURIComponent(
          hyperaudioTemplate
            .replace("{hypertranscript}", getTranscriptData())
            // check to see if it's an mp3, in which case we don't display captions
            .replace("{sourcemedia}", document.querySelector("#hyperplayer").src) 
            .replace("{sourcevtt}", document.querySelector("#hyperplayer-vtt").src)
            //.replace("{sourcevtt}", isAudio ? "" : document.querySelector("#hyperplayer-vtt").src)
        )
    );
  }

  function hasParent(element, parent) {
    let currentElement = element.parentNode;
    
    while (currentElement !== null) {
      if (currentElement === parent) {
        return true;
      }
      
      currentElement = currentElement.parentNode;
    }
    
    return false;
  }

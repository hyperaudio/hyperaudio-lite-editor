/* Extracted verbatim from index.html (#334) — loaded as a classic script in the same document order. */

  // Show the app version (from <meta name="version">) in the info modal, so a
  // bug report can say exactly which build it is — including a stale cached one.
  {
    const versionMeta = document.querySelector('meta[name="version"]');
    const versionOut = document.getElementById('app-version');
    if (versionMeta !== null && versionOut !== null) {
      versionOut.textContent = `Editor v${versionMeta.content}`;
    }
  }

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

  // Interactive-transcript export dialog. The exported page links the media by a
  // RELATIVE path (or its URL), never the session-only blob: URL — so, saved
  // next to the media file, it plays and stays interactive (the template already
  // loads the hyperaudio-lite lib from CDN and boots it). The user confirms the
  // media reference because a freshly-uploaded file's real name isn't retained.
  {
    const iaModal = document.getElementById('interactive-export-modal');
    const iaInput = document.getElementById('interactive-media-filename');
    const iaDownload = document.getElementById('interactive-export-download');

    // Remote media can be linked by its URL as-is; a blob:/data: source (local
    // upload or Recents) has no usable path, so the field starts empty for the
    // user to type the local filename.
    const guessMediaSrc = () => {
      const src = document.querySelector('#hyperplayer') ? document.querySelector('#hyperplayer').src : '';
      return /^https?:/i.test(src) ? src : '';
    };

    if (iaModal !== null && iaInput !== null) {
      iaModal.addEventListener('change', () => {
        if (iaModal.checked && iaInput.value.trim() === '') {
          iaInput.value = guessMediaSrc();
        }
      });
    }

    if (iaDownload !== null && iaInput !== null) {
      iaDownload.addEventListener('click', () => {
        const mediaSrc = iaInput.value.trim();
        if (mediaSrc === '') { iaInput.focus(); return; }
        const track = document.querySelector('#hyperplayer-vtt');
        // function replacements so a literal $ in the transcript/filename isn't
        // treated as a replacement pattern
        const html = hyperaudioTemplate
          .replace('{hypertranscript}', () => getTranscriptData())
          .replace('{sourcemedia}', () => mediaSrc)
          .replace('{sourcevtt}', () => (track !== null ? track.src : ''));
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'interactive-transcript.html';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        if (iaModal !== null) iaModal.checked = false;
      });
    }
  }

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
    // Leave a small gap below the navbar when autoscrolling the active paragraph
    // (passed natively as scrollOffset to the 2.5.x options-object constructor).
    const SCROLL_TOP_GAP = 24;

    // hyperaudio() runs on every transcript (re)load — tear down the previous
    // instance so its player/document listeners don't accumulate (2.6.0 API).
    if (window.hyperaudioInstance && typeof window.hyperaudioInstance.destroy === 'function') {
      window.hyperaudioInstance.destroy();
    }

    const hyperaudioInstance = new HyperaudioLite({
      transcript: "hypertranscript",
      player: "hyperplayer",
      minimizedMode: false,
      autoScroll: true,
      doubleClick: true,
      webMonetization: false,
      playOnClick: false,
      scrollOffset: SCROLL_TOP_GAP,
      // The element that actually scrolls is .transcript-holder, not
      // #hypertranscript (the library default, which is absolutely positioned
      // and doesn't scroll here). Official option since 2.6.0 (#254).
      scrollContainer: document.querySelector('.transcript-holder'),
    });

    // Patch for #294: if the library's polling chain runs while wordArr
    // still references a span deleted by an in-progress edit, the original
    // can throw on a detached word's parentNode and the chain dies silently.
    // Strip detached entries before delegating — the next debounced
    // refreshHyperaudioInstance will rebuild wordArr from the live DOM.
    // (Kept under 2.6.0: the delta-update rewrite is more defensive but some
    // paths still walk parentNode on words an in-progress edit may detach.)
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

    // (The top-gap scrollToParagraph override is gone — 2.5.x applies it natively
    // via the scrollOffset option passed to the constructor above.)

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

      // --- Word-split timing (modular; set WORD_SPLIT_TIMING = false to remove) ---
      // When the user types a space inside a word, contenteditable leaves two (or
      // more) words inside one timed <span>. On blur we split that span into one
      // span per word and estimate each word's timing by dividing the original
      // span's [data-m, data-d] window pro-rata across the parts. Weighting is by
      // estimated syllable count (vowel groups) rather than letters — a reasonable
      // proxy for spoken duration in Latin-script languages.
      const WORD_SPLIT_TIMING = true;

      // Estimate syllables from contiguous vowel groups (Latin-script heuristic).
      // Includes common Romance/Germanic accented vowels and y; floored at 1 so
      // every part carries weight (no zero-duration or divide-by-zero parts).
      const estimateSyllables = function (token) {
        const groups = token.toLowerCase().match(/[aeiouyàáâäãèéêëìíîïòóôöõùúûüýÿ]+/g);
        return Math.max(1, groups ? groups.length : 1);
      };

      // Split one multi-word span into per-word spans, distributing the original
      // duration by syllable weight; parts stay contiguous and their durations sum
      // exactly to the original (last part absorbs any rounding remainder).
      const splitWordSpan = function (span) {
        const tokens = span.textContent.split(/\s+/).filter(t => t.length > 0);
        if (tokens.length < 2) {
          return;
        }
        const m = parseInt(span.getAttribute('data-m'), 10) || 0;
        const d = parseInt(span.getAttribute('data-d'), 10) || 0;
        const weights = tokens.map(estimateSyllables);
        const totalWeight = weights.reduce((a, b) => a + b, 0);

        const frag = document.createDocumentFragment();
        let start = m;
        let allocated = 0;
        for (let i = 0; i < tokens.length; i++) {
          const dur = i === tokens.length - 1
            ? Math.max(0, d - allocated)
            : Math.round((d * weights[i]) / totalWeight);
          allocated += dur;
          const part = span.cloneNode(false); // preserve class and any data-* attrs
          part.setAttribute('data-m', String(start));
          part.setAttribute('data-d', String(dur));
          part.textContent = tokens[i] + ' '; // keep the word separator
          frag.appendChild(part);
          start += dur;
        }
        span.replaceWith(frag);
      };

      // True when nothing but whitespace text sits between nodes a and b.
      const onlyWhitespaceBetween = function (a, b) {
        let n = a.nextSibling;
        while (n && n !== b) {
          if (n.nodeType === Node.ELEMENT_NODE) return false;
          if (n.nodeType === Node.TEXT_NODE && n.nodeValue.trim() !== '') return false;
          n = n.nextSibling;
        }
        return n === b;
      };

      // Repair a letter that LEAKED across a word boundary (#394). Retyping the
      // first letter of a word (delete "e", type "E") makes contenteditable
      // append the new letter after the PREVIOUS span's trailing space, so
      // "Lite " + "Editor " becomes "Lite E" + "ditor ". Signature: a span with
      // an internal space AND no trailing space (distinct from a paste, which
      // keeps a trailing space, and from a join, which has no internal space).
      // Move the post-space fragment to the front of the next word span, which
      // reconstitutes the original word and — because each span keeps its own
      // data-m/data-d — its original timing.
      const reflowLeakedFragments = function (root) {
        const spans = Array.from(root.querySelectorAll('span[data-m]'));
        for (let i = 0; i < spans.length; i++) {
          const span = spans[i];
          if (!span.isConnected || span.classList.contains('speaker')) continue;
          const txt = span.textContent;
          if (!/\S\s+\S/.test(txt) || /\s$/.test(txt)) continue;
          const next = span.nextElementSibling;
          if (!next || !next.hasAttribute('data-m') || next.classList.contains('speaker')) continue;
          if (!onlyWhitespaceBetween(span, next)) continue;
          const cut = txt.lastIndexOf(' ');
          span.textContent = txt.slice(0, cut).replace(/\s+$/, '') + ' ';
          next.textContent = txt.slice(cut + 1) + next.textContent;
        }
      };

      // Merge spans JOINED by deleting the space between two words — the inverse
      // of splitWordSpan (#394). Every well-formed word span ends in whitespace;
      // if one doesn't and is immediately followed by another word span, the user
      // deleted the boundary space to glue the words, so combine them into one
      // timed span: start of the first, end of the last (data-d = next.m + next.d
      // − this.m). The inner loop absorbs a chain when more than two were joined.
      const mergeJoinedSpans = function (root) {
        const spans = Array.from(root.querySelectorAll('span[data-m]'));
        for (let i = 0; i < spans.length; i++) {
          const span = spans[i];
          if (!span.isConnected || span.classList.contains('speaker')) continue;
          while (span.textContent.length > 0 && !/\s$/.test(span.textContent)) {
            const next = span.nextElementSibling;
            if (!next || !next.hasAttribute('data-m') || next.classList.contains('speaker')) break;
            if (!onlyWhitespaceBetween(span, next)) break;
            const m = parseInt(span.getAttribute('data-m'), 10) || 0;
            const nm = parseInt(next.getAttribute('data-m'), 10) || 0;
            const nd = parseInt(next.getAttribute('data-d'), 10) || 0;
            span.setAttribute('data-d', String(Math.max(0, (nm + nd) - m)));
            // span carries no trailing space; next brings its own — the glued
            // word keeps a single trailing separator
            span.textContent = span.textContent + next.textContent;
            next.remove();
          }
        }
      };

      transcriptEl.addEventListener('blur', () => {
        // Strip non-breaking spaces (U+00A0) that contenteditable injects on edit,
        // back to regular spaces (#339). The textContent check keeps the common
        // (no-nbsp) case a cheap early-out.
        if (transcriptEl.textContent.indexOf('\u00A0') !== -1) {
          const walker = document.createTreeWalker(transcriptEl, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.nodeValue.indexOf('\u00A0') !== -1) {
              node.nodeValue = node.nodeValue.replace(/\u00A0/g, ' ');
            }
          }
        }

        if (WORD_SPLIT_TIMING) {
          // Order matters and the three conditions are disjoint: reflow a leaked
          // boundary letter first (internal space + no trailing space), then
          // merge words glued by a deleted space (no internal space + no trailing
          // space), then split words separated by an added space (internal space
          // + trailing space). A clean word is left untouched by all three.
          reflowLeakedFragments(transcriptEl);
          mergeJoinedSpans(transcriptEl);
          // Split any span that now holds more than one word (internal whitespace
          // between non-space characters). Touches only affected spans, so the
          // common single-word case costs one regex test per span.
          const spans = transcriptEl.querySelectorAll('span[data-m]');
          for (let i = 0; i < spans.length; i++) {
            if (/\S\s+\S/.test(spans[i].textContent)) {
              splitWordSpan(spans[i]);
            }
          }
        }
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
        document.querySelector('.transcript-holder').style.left = '16px';
        // slide the side panel off-screen too — otherwise it lingers
        // underneath and the video peeks through the 8px gap above the
        // floating transcript card (#375)
        document.querySelector('.side-panel').style.left = '-400px';
        document.querySelector('#sidebar-close-icon').style.display = "none";
        document.querySelector('#sidebar-open-icon').style.display = "block";
        sidebarOpen = false;
      } else {
        document.querySelector('.holder').style.left = "400px";
        document.querySelector('.main-panel').style.left = "400px";
        document.querySelector('.transcript-holder').style.left = "400px";
        document.querySelector('.side-panel').style.left = '0px';
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

  // (Removed the old ≤480px hack that cloned #hyperplayer into .transcript-holder
  // and deleted the original — the responsive layout (#349) now keeps the player
  // in its pinned pane, so moving it into the transcript broke both.)

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

    // check to see if it's an mp3 or m4a, in which case we don't display captions
    let extension = document.querySelector('#hyperplayer').src.split('.').pop();
    if (extension === "mp3" || extension === "m4a") {
      document.querySelector('#hyperplayer').textTracks[0].mode = "hidden";
    } else {
      document.querySelector('#hyperplayer').textTracks[0].mode = "showing";
    }
    return subs.data;
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

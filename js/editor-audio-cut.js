/* Extracted verbatim from index.html (#334) — loaded as a module in the same document order. */
  import { AudioData, cutAudioApp } from "./audio-cut.js";

  const audioDataArray = [];
  let skipListenersAttached = false;

  let removeGapsEnabled = false;
  let gapThreshold = 0.5;
  let gapBuffer = 0.1;

  document.querySelector('#strikethrough').addEventListener('click', () => {
    applyStrikeThroughToSelection();
    rebuildAudioDataArray();
    ensureSkipListeners();
  });

  function applyGapSettings() {
    const enabledEl = document.querySelector('#remove-gaps-enabled');
    const thresholdEl = document.querySelector('#remove-gaps-threshold');
    const bufferEl = document.querySelector('#remove-gaps-buffer');
    removeGapsEnabled = !!enabledEl.checked;
    const thresholdMs = parseFloat(thresholdEl.value);
    if (!isNaN(thresholdMs) && thresholdMs > 0) {
      gapThreshold = thresholdMs / 1000;
    }
    const bufferMs = parseFloat(bufferEl.value);
    if (!isNaN(bufferMs) && bufferMs >= 0) {
      gapBuffer = bufferMs / 1000;
    }
    rebuildAudioDataArray();
    ensureSkipListeners();
    updateRemoveGapsBtnState();
    updateGapSavingsMessage();
  }

  document.querySelector('#remove-gaps-enabled').addEventListener('change', applyGapSettings);
  document.querySelector('#remove-gaps-threshold').addEventListener('input', applyGapSettings);
  document.querySelector('#remove-gaps-buffer').addEventListener('input', applyGapSettings);

  function updateRemoveGapsBtnState() {
    const dot = document.querySelector('#remove-gaps-active-dot');
    if (!dot) return;
    dot.style.display = removeGapsEnabled ? 'block' : 'none';
  }

  function computeGapSavings() {
    const transcript = getTranscript();
    if (!transcript) return 0;
    const words = transcript.querySelectorAll('[data-m]');
    let saved = 0;
    let prevWordEnd = null;
    let prevWordStruck = false;
    words.forEach(word => {
      const struck = isStruck(word);
      const wordStart = parseInt(word.getAttribute('data-m')) / 1000;
      const wordEnd = wordStart + (parseInt(word.getAttribute('data-d')) || 0) / 1000;
      if (!struck && prevWordEnd !== null && !prevWordStruck) {
        const gap = wordStart - prevWordEnd;
        if (gap > gapThreshold) {
          const skipStart = prevWordEnd + gapBuffer;
          const skipEnd = wordStart - gapBuffer;
          if (skipEnd > skipStart) {
            saved += skipEnd - skipStart;
          }
        }
      }
      prevWordEnd = wordEnd;
      prevWordStruck = struck;
    });
    return saved;
  }

  function formatGapSavings(seconds) {
    if (seconds < 60) {
      return `${seconds.toFixed(1)} seconds`;
    }
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0) parts.push(`${s}s`);
    return parts.join(' ');
  }

  function updateGapSavingsMessage() {
    const el = document.querySelector('#remove-gaps-savings');
    if (!el) return;
    if (!removeGapsEnabled) {
      el.style.display = 'none';
      return;
    }
    const saved = computeGapSavings();
    el.textContent = `Playback shortened by ${formatGapSavings(saved)}`;
    el.style.display = 'block';
  }

  registerStrikeThrus();
  window.document.addEventListener('hyperaudioTranscriptLoaded', registerStrikeThrus, false);
  // Also rebuild on hyperaudioInit so transcribe (Deepgram/Whisper) and
  // JSON/SRT/VTT import inherit the current gap-skip settings against the
  // freshly-loaded transcript.
  window.document.addEventListener('hyperaudioInit', registerStrikeThrus, false);

  // Recalculate gap-skips and the savings message when the user edits the
  // transcript (e.g., deletes a word — the time it occupied becomes a gap).
  // Debounced so we coalesce rapid keystrokes. Delegated on document so the
  // listener survives transcript element replacement via restoreTranscript().
  let gapRecalcTimer = null;
  document.addEventListener('input', (e) => {
    if (!e.target || e.target.id !== 'hypertranscript') return;
    clearTimeout(gapRecalcTimer);
    gapRecalcTimer = setTimeout(registerStrikeThrus, 150);
  });

  function registerStrikeThrus() {
    rebuildAudioDataArray();
    ensureSkipListeners();
    updateGapSavingsMessage();
    refreshHyperaudioInstance();
  }

  // Refresh the library's cached word array so the karaoke highlight stays in
  // sync with the current DOM after structural edits. Without this, the
  // existing sanitise()-driven refresh runs at 1000ms vs. our 150ms gap
  // recalc, leaving the highlight pointing at detached nodes in between.
  function refreshHyperaudioInstance() {
    const instance = window.hyperaudioInstance;
    if (!instance || !instance.transcript) return;
    const words = instance.transcript.querySelectorAll('[data-m]');
    instance.wordArr = instance.createWordArray(words);
    instance.parentElements = instance.transcript.getElementsByTagName(instance.parentTag);
    if (instance.currentTime !== undefined) {
      instance.updateTranscriptVisualState(instance.currentTime);
    }
    // The library's polling chain may have died silently mid-edit if its
    // cached wordArr referenced a deleted span (word.n.parentNode === null
    // throws inside the setTimeout callback). Kicking checkPlayHead clears
    // any pending timer and starts a fresh poll against the refreshed array.
    if (typeof instance.checkPlayHead === 'function') {
      instance.checkPlayHead();
    }
  }

  function getTranscript() {
    let transcript = document.querySelector("#hypertranscript");
    if (transcript == null && typeof transcriptCache !== "undefined") {
      transcript = transcriptCache.querySelector && transcriptCache.querySelector("#hypertranscript");
    }
    return transcript;
  }

  function isStruck(el) {
    return el.style.textDecoration.includes('line-through');
  }

  function strikeoutElement(element) {
    if (element.nodeType === Node.ELEMENT_NODE && !isStruck(element)) {
      element.style.textDecoration = 'line-through';
    }
  }

  function unstrikeElement(element) {
    if (element.nodeType === Node.ELEMENT_NODE && isStruck(element)) {
      element.style.textDecoration = '';
    }
  }

  // Map the user's Range to the spans it actually covers, regardless of where
  // the caret was parked (text node, span boundary, or paragraph element).
  function applyStrikeThroughToSelection() {
    const transcript = getTranscript();
    if (!transcript) return;

    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);

    const allSpans = Array.from(transcript.querySelectorAll('[data-m]'));
    let startSpan = null;
    let endSpan = null;
    for (const span of allSpans) {
      if (range.intersectsNode(span) && span.textContent.trim() !== '') {
        if (!startSpan) startSpan = span;
        endSpan = span;
      }
    }
    if (!startSpan || !endSpan) return;

    let startIndex = allSpans.indexOf(startSpan);
    const endIndex = allSpans.indexOf(endSpan);

    // Trim leading spaces — if the selection only touches the trailing space
    // of a word, that word shouldn't be struck.
    let selectedText = range.toString();
    while (selectedText.startsWith(' ') && startIndex < endIndex) {
      startIndex++;
      selectedText = selectedText.slice(1);
    }

    const selectedSpans = allSpans.slice(startIndex, endIndex + 1);
    const action = selectedSpans.every(isStruck) ? unstrikeElement : strikeoutElement;
    selectedSpans.forEach(action);

    selection.removeAllRanges();
  }

  function computePlayableSections(transcript) {
    const words = transcript.querySelectorAll('[data-m]');
    const player = document.getElementById("hyperplayer");
    const duration = (player && !isNaN(player.duration) && player.duration > 0) ? player.duration : Infinity;

    if (words.length === 0) {
      return [{ start: 0, end: duration }];
    }

    const sections = [];
    let current = { start: 0 };
    let inStruck = false;
    let lastStruckEnd = 0;
    let prevWordEnd = null;
    let prevWordStruck = false;

    words.forEach(word => {
      const struck = isStruck(word);
      const wordStart = parseInt(word.getAttribute('data-m')) / 1000;
      const wordEnd = wordStart + (parseInt(word.getAttribute('data-d')) || 0) / 1000;

      // Long-gap skipping: when both surrounding words are unstruck and the
      // gap exceeds the threshold, skip the middle of the gap, keeping a
      // small buffer on each side so word edges aren't clipped.
      if (
        removeGapsEnabled &&
        !inStruck && !struck &&
        prevWordEnd !== null &&
        !prevWordStruck &&
        current !== null
      ) {
        const gap = wordStart - prevWordEnd;
        if (gap > gapThreshold) {
          const skipStart = prevWordEnd + gapBuffer;
          const skipEnd = wordStart - gapBuffer;
          if (skipEnd > skipStart) {
            current.end = skipStart;
            sections.push(current);
            current = { start: skipEnd };
          }
        }
      }

      if (struck) {
        if (!inStruck) {
          current.end = wordStart;
          sections.push(current);
          current = null;
          inStruck = true;
        }
        lastStruckEnd = wordEnd;
      } else if (inStruck) {
        current = { start: lastStruckEnd };
        inStruck = false;
      }

      prevWordEnd = wordEnd;
      prevWordStruck = struck;
    });

    if (current === null) {
      current = { start: lastStruckEnd };
    }
    current.end = duration;
    sections.push(current);

    return sections;
  }

  // Mutate audioDataArray in place so any listener closures see the update.
  function rebuildAudioDataArray() {
    const transcript = getTranscript();
    audioDataArray.length = 0;
    if (!transcript) return;

    const sections = computePlayableSections(transcript);
    const mediaUrl = document.querySelector("#hyperplayer").src;
    sections.forEach(s => audioDataArray.push(new AudioData(mediaUrl, s.start, s.end)));
  }

  // Attach the play/pause/seeked listeners exactly once. Earlier code attached
  // a fresh pair on every strike, leaking listeners and stale closures.
  function ensureSkipListeners() {
    if (skipListenersAttached) return;
    const myPlayer = window.hyperaudioInstance && window.hyperaudioInstance.player;
    if (!myPlayer) return;

    let animationFrameId = null;

    function update() {
      checkStrikeThrus(myPlayer);
      animationFrameId = requestAnimationFrame(update);
    }

    myPlayer.addEventListener("play", () => {
      if (!animationFrameId) {
        animationFrameId = requestAnimationFrame(update);
      }
    });

    myPlayer.addEventListener("pause", () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    });

    // Catch the case where the user clicks/seeks into a struck region while
    // paused, or where RAF hasn't ticked yet at the boundary.
    myPlayer.addEventListener("seeked", () => checkStrikeThrus(myPlayer));
    myPlayer.addEventListener("timeupdate", () => checkStrikeThrus(myPlayer));

    skipListenersAttached = true;
  }

  // Use >= on the lower bound so we jump the instant currentTime reaches the
  // struck region — without this the first word can sneak through between
  // RAF ticks.
  function checkStrikeThrus(myPlayer) {
    if (audioDataArray.length < 2) return;
    const t = myPlayer.currentTime;
    for (let i = 0; i < audioDataArray.length - 1; i++) {
      const stop = audioDataArray[i].stop;
      const nextStart = audioDataArray[i + 1].start;
      if (t >= stop && t < nextStart) {
        myPlayer.currentTime = nextStart + 0.05;
        // The library only listens for play/pause natively, not seeked, so
        // it has no idea we just jumped. Kick its polling chain so the
        // highlight re-locks onto the post-skip word instead of waiting for
        // its stale setTimeout to fire seconds later.
        const instance = window.hyperaudioInstance;
        if (instance && typeof instance.checkPlayHead === 'function') {
          instance.checkPlayHead();
        }
        return;
      }
    }
  }

  document
    .getElementById("download-wav-cut")
    .addEventListener("click", async () => {
      // grab the filename if saved
      const element = document.querySelector(".file-item.active");

      let fileName;
      if (element == null || typeof element === "undefined"){
        fileName = "default";
      } else {
        fileName = element.textContent;
      }

      if (audioDataArray.length === 0) {
        audioDataArray.push(
          new AudioData(
            document.querySelector("#hyperplayer").src,
            0,
            document.getElementById("hyperplayer").duration
          )
        );
      }

      let wavBlob = await cutAudioApp.cutAudio(audioDataArray);
      cutAudioApp.to_wav(wavBlob, fileName);
      
    });

    // Add event listener for the new Upload & Transcribe button
    document.getElementById('upload-transcribe-btn').addEventListener('click', function() {
      // Programmatically check the transcribe-modal checkbox to open the modal
      document.getElementById('transcribe-modal').checked = true;
    });

    document.getElementById('upload-align-btn').addEventListener('click', function() {
      document.getElementById('align-modal').checked = true;
    });

    // Add event listener for ALIGN button
    document.getElementById('align-text-btn').addEventListener('click', function() {
      alignTranscriptText();
    });

    // Word Alignment Algorithm with Loader
    /*
    function alignTranscriptText() {
      console.log("aligning...");
      try {
        // Get the pasted text from the textarea
        const plainText = document.getElementById('align-text-input').value.trim();
        
        if (!plainText) {
          alert('Please paste some text to align.');
          return;
        }

        // Get the current timed transcript HTML
        const hypertranscriptDiv = document.getElementById('hypertranscript');
        if (!hypertranscriptDiv) {
          alert('No timed transcript found.');
          return;
        }

        // Store original content in case we need to restore it on error
        const originalContent = hypertranscriptDiv.innerHTML;

        // Close the modal first
        document.getElementById('align-modal').checked = false;

        // Clear the textarea
        document.getElementById('align-text-input').value = '';

        // Wait for modal to close, then show loader and start alignment
        setTimeout(() => {
          // Show loader
          hypertranscriptDiv.innerHTML = '<div class="vertically-centre"><center>Aligning transcript....</center><br/><img src="'+transcribingSvg+'" width="50" alt="aligning" style="margin: auto; display: block;"></div>';

          // Short delay to allow loader to render before processing
          setTimeout(() => {
          try {
            // Extract words and timings from existing HTML
            const { words: sourceWords, timings, htmlStructure } = extractTimedWords(originalContent);
            
            if (sourceWords.length === 0) {
              hypertranscriptDiv.innerHTML = originalContent;
              alert('No timed words found in the current transcript.');
              return;
            }

            // Split plain text into words, excluding speaker names
            const targetWords = extractWordsWithoutSpeakers(plainText);

            // Align words
            const alignment = alignWords(sourceWords, targetWords);

            // Generate new HTML with aligned timings and paragraph structure
            const newHTML = generateAlignedHTML(alignment, sourceWords, targetWords, timings, htmlStructure, plainText);

            // Update the hypertranscript div with aligned content
            hypertranscriptDiv.innerHTML = newHTML;

            // Reinitialize hyperaudio to recognize the new transcript
            if (typeof hyperaudio === 'function') {
              hyperaudio();
            }

          } catch (error) {
            console.error('Alignment error:', error);
            hypertranscriptDiv.innerHTML = originalContent;
            alert('Error during alignment: ' + error.message);
          }
          }, 100); // Small delay to allow loader to render
        }, 300); // Wait for modal close animation

      } catch (error) {
        console.error('Alignment error:', error);
        alert('Error during alignment: ' + error.message);
      }
    }*/

    // Word Alignment Algorithm with Loader
    function alignTranscriptText() {
      console.log("aligning ...");
      try {
        // Get the pasted text from the textarea
        const plainText = document.getElementById('align-text-input').value.trim();
        
        if (!plainText) {
          alert('Please paste some text to align.');
          return;
        }

        // Get the current timed transcript HTML
        const hypertranscriptDiv = document.getElementById('hypertranscript');
        if (!hypertranscriptDiv) {
          alert('No timed transcript found.');
          return;
        }

        // Store original content in case we need to restore it on error
        const originalContent = hypertranscriptDiv.innerHTML;

        // Close the modal first
        document.getElementById('align-modal').checked = false;

        // Clear the textarea
        document.getElementById('align-text-input').value = '';

        // Wait for modal to close, then show loader and start alignment
        setTimeout(() => {
          // Show loader
          hypertranscriptDiv.innerHTML = '<div class="vertically-centre"><center>Aligning transcript....</center><br/><img src="'+transcribingSvg+'" width="50" alt="aligning" style="margin: auto; display: block;"></div>';

          // Short delay to allow loader to render before processing
          setTimeout(() => {
            try {
              // Convert HTML to JSON
              const machineJSON = htmlToJSON(originalContent);
              
              if (!machineJSON.words || machineJSON.words.length === 0) {
                hypertranscriptDiv.innerHTML = originalContent;
                alert('No timed words found in the current transcript.');
                return;
              }

              // Align transcripts (JSON to JSON)
              const alignedJSON = alignTranscripts(machineJSON, plainText);

              // Convert aligned JSON back to HTML
              const newHTML = jsonToHTML(alignedJSON);

              // Update the hypertranscript div with aligned content
              hypertranscriptDiv.innerHTML = newHTML;

              // Reinitialize hyperaudio to recognize the new transcript
              if (typeof hyperaudio === 'function') {
                hyperaudio();
              }

              // Regenerate captions from the newly aligned transcript
              hyperaudioGenerateCaptionsFromTranscript();

            } catch (error) {
              console.error('Alignment error:', error);
              hypertranscriptDiv.innerHTML = originalContent;
              alert('Error during alignment: ' + error.message);
            }
          }, 100); // Small delay to allow loader to render
        }, 300); // Wait for modal close animation

      } catch (error) {
        console.error('Alignment error:', error);
        alert('Error during alignment: ' + error.message);
      }
    }

    // Alignment functions are now in js/word-alignment.js


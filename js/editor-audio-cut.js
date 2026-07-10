/* Extracted verbatim from index.html (#334) — loaded as a module in the same document order. */
  import { AudioData } from "./audio-cut.js";

  const audioDataArray = [];
  let skipListenersAttached = false;

  let removeGapsEnabled = false;
  let gapThreshold = 0.5;
  let gapBuffer = 0.1;

  const strikethroughBtn = document.querySelector('#strikethrough');

  strikethroughBtn.addEventListener('click', () => {
    if (strikethroughBtn.classList.contains('btn-disabled')) return;
    applyStrikeThroughToSelection();
    rebuildAudioDataArray();
    ensureSkipListeners();
  });

  // #274: grey out the strikethrough button unless text is selected in the
  // transcript. The selection survives clicking the button (which is what the
  // click handler above relies on), so disabling via selectionchange can't
  // race a legitimate click.
  function updateStrikethroughState() {
    const transcript = document.getElementById('hypertranscript');
    const selection = window.getSelection();
    let enabled = false;
    if (transcript && selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      enabled = selection.getRangeAt(0).intersectsNode(transcript);
    }
    strikethroughBtn.classList.toggle('btn-disabled', !enabled);
    strikethroughBtn.setAttribute('aria-disabled', String(!enabled));
  }
  document.addEventListener('selectionchange', updateStrikethroughState);
  updateStrikethroughState();

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

  // Read/apply for the project save module (js/hyperaudio-save.js): the gap
  // settings are module-locals here, and a loaded .hyperaudio project must be
  // able to restore them. Applying goes through the UI controls so the dialog
  // stays in sync, then reuses the normal applyGapSettings() path.
  window.getGapRemovalSettings = function () {
    return {
      enabled: removeGapsEnabled,
      thresholdMs: Math.round(gapThreshold * 1000),
      bufferMs: Math.round(gapBuffer * 1000),
    };
  };
  window.applyGapRemovalSettings = function (settings) {
    if (!settings || typeof settings !== 'object') return;
    const enabledEl = document.querySelector('#remove-gaps-enabled');
    const thresholdEl = document.querySelector('#remove-gaps-threshold');
    const bufferEl = document.querySelector('#remove-gaps-buffer');
    if (typeof settings.enabled === 'boolean' && enabledEl) {
      enabledEl.checked = settings.enabled;
    }
    if (Number.isFinite(settings.thresholdMs) && settings.thresholdMs > 0 && thresholdEl) {
      thresholdEl.value = String(settings.thresholdMs);
    }
    if (Number.isFinite(settings.bufferMs) && settings.bufferMs >= 0 && bufferEl) {
      bufferEl.value = String(settings.bufferMs);
    }
    applyGapSettings();
  };

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
    const wordEls = transcript.querySelectorAll('[data-m]');
    const player = document.getElementById("hyperplayer");
    const duration = (player && !isNaN(player.duration) && player.duration > 0) ? player.duration : Infinity;

    if (wordEls.length === 0) {
      return [{ start: 0, end: duration }];
    }

    const words = Array.from(wordEls).map(el => {
      const start = parseInt(el.getAttribute('data-m')) / 1000;
      return { start, end: start + (parseInt(el.getAttribute('data-d')) || 0) / 1000, struck: isStruck(el) };
    });

    // Two passes. First, the regions between consecutive KEPT (unstruck) words:
    // everything in such a region is non-speech once its struck words are cut,
    // so with gap skipping on we treat the region as one combined pause — if
    // the pause left after removing the struck words exceeds the threshold,
    // cut the whole region (keeping a small buffer at each edge so word edges
    // aren't clipped). Otherwise cut just the struck spans. The old one-pass
    // version only gap-checked between two unstruck neighbours, so the pauses
    // AROUND a struck filler word were never skipped.
    const cuts = [];
    let prevKeptEnd = null;
    let pendingStruck = [];

    // A run of struck words in one region is always ONE cut spanning from the
    // first struck word's start to the last one's end, so the silences BETWEEN
    // struck words go with them (cutting only the word spans left those pauses
    // playing back-to-back — audible fragments of the struck region).
    const struckRunCut = (struckSpans) => {
      if (struckSpans.length === 0) return null;
      let end = struckSpans[0].end;
      struckSpans.forEach(s => { if (s.end > end) end = s.end; }); // tolerate overlapping word timings
      return { start: struckSpans[0].start, end };
    };

    const flushRegion = (regionStart, regionEnd, struckSpans, bufferLeft, bufferRight) => {
      const run = struckRunCut(struckSpans);
      if (removeGapsEnabled && regionStart !== null) {
        const struckTotal = struckSpans.reduce((sum, s) => sum + (s.end - s.start), 0);
        const effectivePause = (regionEnd - regionStart) - struckTotal;
        if (effectivePause > gapThreshold) {
          // cut the whole region; the edge buffers protect the neighbouring
          // kept words' tails, but never at the price of keeping struck audio
          const cutStart = Math.min(regionStart + (bufferLeft ? gapBuffer : 0), run !== null ? run.start : Infinity);
          const cutEnd = Math.max(regionEnd - (bufferRight ? gapBuffer : 0), run !== null ? run.end : -Infinity);
          if (cutEnd > cutStart) {
            cuts.push({ start: cutStart, end: cutEnd });
            return;
          }
        }
      }
      // gaps kept (or gap skipping off): cut the struck run whole
      if (run !== null) cuts.push(run);
    };

    words.forEach(word => {
      if (word.struck) {
        pendingStruck.push(word);
        return;
      }
      if (pendingStruck.length > 0 || prevKeptEnd !== null) {
        const regionStart = prevKeptEnd !== null ? prevKeptEnd : (pendingStruck.length ? pendingStruck[0].start : null);
        if (regionStart !== null && word.start > regionStart) {
          flushRegion(regionStart, word.start, pendingStruck, prevKeptEnd !== null, true);
        } else {
          const run = struckRunCut(pendingStruck);
          if (run !== null) cuts.push(run);
        }
      }
      pendingStruck = [];
      prevKeptEnd = word.end;
    });

    // trailing region after the last kept word
    if (pendingStruck.length > 0) {
      const regionStart = prevKeptEnd !== null ? prevKeptEnd : pendingStruck[0].start;
      const regionEnd = pendingStruck[pendingStruck.length - 1].end;
      if (regionEnd > regionStart) {
        flushRegion(regionStart, regionEnd, pendingStruck, prevKeptEnd !== null, false);
      }
    }

    // Second pass: subtract the merged cuts from [0, duration].
    cuts.sort((a, b) => a.start - b.start);
    const sections = [];
    let cursor = 0;
    cuts.forEach(cut => {
      const start = Math.max(cut.start, cursor);
      if (start >= cut.end) { cursor = Math.max(cursor, cut.end); return; }
      if (start > cursor) sections.push({ start: cursor, end: start });
      cursor = cut.end;
    });
    if (cursor < duration) sections.push({ start: cursor, end: duration });
    if (sections.length === 0) sections.push({ start: duration, end: duration });

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

  // The old direct WAV download (which also mutated audioDataArray as a
  // fallback, #290) is replaced by the export modal (js/media-export.js,
  // #289/#291/#292). Expose the kept-sections model so the export can apply
  // exactly the same strikeout + gap-skip cuts as playback does.
  window.getPlayableSections = () => {
    const transcript = getTranscript();
    return transcript ? computePlayableSections(transcript) : null;
  };

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


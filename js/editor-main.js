/* Extracted verbatim from index.html (#334) — loaded as a classic script in the same document order. */
    window.document.addEventListener('hyperaudioPopulateCaptionEditor', populateCaptionEditor, false);

    function restoreTranscript() {
      document.querySelector('.transcript-holder').innerHTML = "";
      let hypertranscript = transcriptCache.querySelector("#hypertranscript");
      document.querySelector('.transcript-holder').appendChild(hypertranscript);
      hyperaudio();
    }

    /* ---- Reading rate per caption (#639) ------------------------------------
     * Editing captions well means knowing whether a cue can be read in the
     * time it is on screen, and the standards differ by trade: characters per
     * second for streaming (Netflix allows 17 in English), words per minute
     * for broadcast (the BBC works to about 160-180). Which one is shown is
     * the user's choice, in Settings.
     *
     * Read from the INPUTS, not from any cached model: a half-typed timecode
     * or a re-worded line has to show up straight away, and those fields are
     * the only place it exists until the caption is committed.
     * ---------------------------------------------------------------------- */
    const CAPTION_RATE_MEASURES = ['cps', 'wpm', 'none'];
    function captionRateMeasure() {
      const settings = window.HyperaudioSettings;
      const choice = settings && typeof settings.get === 'function' ? settings.get('captionRate') : 'cps';
      return CAPTION_RATE_MEASURES.indexOf(choice) === -1 ? 'cps' : choice;
    }

    // Clicking a rate switches the measure, for every caption at once: it is
    // one editorial standard, not a per-caption choice, and reading two
    // scales down the same column would tell you nothing. Only between the
    // two measures — 'none' is chosen in Settings, since a hidden rate leaves
    // nothing to click back with.
    function toggleCaptionRateMeasure() {
      const settings = window.HyperaudioSettings;
      if (!settings || typeof settings.set !== 'function') return;
      const next = captionRateMeasure() === 'cps' ? 'wpm' : 'cps';
      settings.set('captionRate', next);
      const select = document.getElementById('setting-caption-rate');
      if (select !== null) select.value = next;   // Settings may be open behind
      updateCaptionRates();
    }
    window.toggleCaptionRateMeasure = toggleCaptionRateMeasure;

    // Delegated, because the rows are rebuilt on every populate.
    document.addEventListener('click', (event) => {
      const el = event.target && event.target.closest ? event.target.closest('.caption-rate') : null;
      if (el !== null) toggleCaptionRateMeasure();
    });

    // "00:00:01.000" or "00:01.000" -> seconds. NaN for anything else, which
    // is what a timecode being typed looks like half of the time.
    function captionTimecodeSeconds(value) {
      const text = String(value === undefined || value === null ? '' : value).trim();
      const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(text);
      if (m === null) return NaN;
      const hours = m[1] === undefined ? 0 : Number(m[1]);
      return hours * 3600 + Number(m[2]) * 60 + Number(m[3])
        + (m[4] === undefined ? 0 : Number(m[4].padEnd(3, '0')) / 1000);
    }

    function updateCaptionRates() {
      const measure = captionRateMeasure();
      const other = measure === 'cps' ? 'words per minute' : 'characters per second';
      // The limit this measure is judged against, or null when there is none
      // to judge by (#641).
      const bound = typeof captionRateLimit === 'function' ? captionRateLimit() : null;
      const limit = bound !== null && bound.measure === measure ? bound.limit : null;
      document.querySelectorAll('#captions-display .caption').forEach((caption) => {
        const out = caption.querySelector('.caption-rate');
        if (out === null) return;
        if (measure === 'none') {          // switched off in Settings
          out.hidden = true;
          out.textContent = '';
          out.classList.remove('caption-rate-over');
          out.setAttribute('title', '');
          return;
        }
        out.hidden = false;
        const startEl = caption.querySelector('.start');
        const endEl = caption.querySelector('.end');
        const line1 = caption.querySelector('.line1');
        const line2 = caption.querySelector('.line2');
        if (startEl === null || endEl === null) return;
        const text = [line1 === null ? '' : line1.value, line2 === null ? '' : line2.value]
          .map((line) => String(line || '').trim()).filter((line) => line !== '').join(' ');
        const seconds = captionTimecodeSeconds(endEl.value) - captionTimecodeSeconds(startEl.value);
        // nothing to say about an empty caption, or about a duration that is
        // zero, negative or still being typed
        if (!Number.isFinite(seconds) || seconds <= 0 || text === '') {
          out.textContent = '';
          out.setAttribute('title', '');
          return;
        }
        // Judged on the number as SHOWN, not the one behind it: a caption
        // reading 17.0 flagged against a limit of 17 looks like a bug, and
        // arguing that it was really 17.04 helps nobody.
        let shown;
        let counted;
        if (measure === 'wpm') {
          const words = text.split(/\s+/).filter((word) => word !== '').length;
          shown = Math.round((words / seconds) * 60);
          out.textContent = shown + ' wpm';
          counted = `${words} words in ${seconds.toFixed(2)}s`;
        } else {
          const characters = text.length;   // including the spaces, as the standards count them
          shown = Math.round((characters / seconds) * 10) / 10;
          out.textContent = shown.toFixed(1) + ' cps';
          counted = `${characters} characters in ${seconds.toFixed(2)}s`;
        }
        // Over the limit is said three ways — colour, weight, and words in the
        // tooltip — so it survives a colour-blind reader and a screenshot.
        // Advisory: nothing is blocked and nothing is rewritten (#641).
        const over = limit !== null && shown > limit;
        out.classList.toggle('caption-rate-over', over);
        out.setAttribute('title', over
          ? `${counted} — over the ${limit} ${measure} limit. Click to show ${other}`
          : `${counted} — click to show ${other}`);
      });
    }
    // Settings reaches this when the measure changes, and so does anything
    // else that rewrites the rows.
    window.updateCaptionRates = updateCaptionRates;

    function populateCaptionEditor(data) {

      let holder = null;

      // only actually inject the caption HTML if we are in "captionMode"
      if (captionMode === true) {
        holder = document.querySelector('.transcript-holder');
      } else {
        holder = document.createElement('div');
        holder.className = 'transcript-holder';
      }
      

      // Icon only, with the words in a tooltip: the button sits over the
      // caption rows, and a label that wide covers them for no gain — the
      // confirmation modal it opens says what it does in full.
      holder.innerHTML = '<div class="modal-action"><label id="regenerate-float-btn" for="regenerate-captions-modal" class="fixed top-20 right-8 btn btn-square btn-outline btn-primary tooltip" data-tip="Regenerate captions from transcript" aria-label="Regenerate captions from transcript"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-list-restart"><path d="M21 6H3"></path><path d="M7 12H3"></path><path d="M7 18H3"></path><path d="M12 18a5 5 0 0 0 9-3 4.5 4.5 0 0 0-4.5-4.5c-1.33 0-2.54.54-3.41 1.41L11 14"></path><path d="M11 10v4h4"></path></svg></label></div>';

      // The cache exists to preserve HAND-EDITED captions across view
      // switches. While captions are machine-synced from the transcript it
      // must never be trusted: it is primed at transcription time (the
      // engines' caption pass runs this builder with captionMode false), and
      // transcript edits then regenerate the TRACK but not these rows — so
      // the first visit to the caption editor showed pre-edit captions. Any
      // hand edit flips updateCaptionsFromTranscript false, and from then on
      // the cache is authoritative again.
      if (captionCache === null || updateCaptionsFromTranscript === true) {
        let newDiv = document.createElement('div');

        // Set an id for the new div
        newDiv.id = 'captions-display';

        // Append the new div to the existing div

        holder.insertAdjacentElement('beforeEnd', newDiv);

        // Initialize the DOM parser
        let parser = new DOMParser();
        let html = document.querySelector('#caption-template-holder').innerHTML;

        // Parse the text
        let template = parser.parseFromString(html, "text/html");

        let index = 0;
        data.forEach(cap => {
          let line1 = cap.text.split('\n')[0];
          let line2 = cap.text.split('\n')[1];

          if (line2 === undefined || typeof line2 === "undefined") {
            line2 = "";
          }

          let captionTempl = template.querySelector('#caption-template').cloneNode(true);
          captionTempl.id = "caption-"+index;
          index++;
          captionTempl.querySelector('.start').value = cap.start;
          captionTempl.querySelector('.end').value = cap.stop;
          captionTempl.querySelector('.line1').value = line1;
          captionTempl.querySelector('.line2').value = line2;
          // The speaker this caption was generated from (#536). It rides on
          // the row, not in the text, so it survives every edit without ever
          // showing up in a text box or counting against the reading rate.
          // captureCaptions serialises the row, so the cache carries it too.
          if (typeof cap.speaker === 'string' && cap.speaker !== '') {
            captionTempl.setAttribute('data-speaker', cap.speaker);
          }

          holder.querySelector('#captions-display').insertAdjacentElement('beforeEnd', captionTempl);
        });

        captionCache = captureCaptions(holder);

      } else {
        holder.innerHTML = captionCache;
      }

      const captionsDisplay = document.getElementById('captions-display');
      if (captionsDisplay !== null) {
        captionsDisplay.addEventListener('change', (e) => {
          captionCache = captureCaptions(holder);
          generateCaptionsFromCaptionEditor();
        });
      }

      updateCaptionRates();   // freshly built rows, or the cache restored (#639)
    } 

    function captureCaptions(holder) {
      // Get the form element
      const form = holder;
      
      // Create a deep clone of the form
      const formClone = form.cloneNode(true);
      
      // Update all input values in the clone to match current values
      const inputs = form.querySelectorAll('input, textarea, select');
      const clonedInputs = formClone.querySelectorAll('input, textarea, select');
      
      inputs.forEach((input, index) => {
          const clonedInput = clonedInputs[index];
          
          if (input.type === 'checkbox' || input.type === 'radio') {
              clonedInput.checked = input.checked;
              if (input.checked) {
                  clonedInput.setAttribute('checked', 'checked');
              } else {
                  clonedInput.removeAttribute('checked');
              }
          } else if (input.tagName === 'SELECT') {
              Array.from(input.options).forEach((option, optIndex) => {
                  clonedInput.options[optIndex].selected = option.selected;
                  if (option.selected) {
                      clonedInput.options[optIndex].setAttribute('selected', 'selected');
                  } else {
                      clonedInput.options[optIndex].removeAttribute('selected');
                  }
              });
          } else {
              clonedInput.value = input.value;
              clonedInput.setAttribute('value', input.value);
          }
      });
      
      // Get the HTML string
      const formHTML = formClone.innerHTML;
      
      // Log or use the HTML string as needed
      return formHTML;
    }

    // `speakers` is the list a project saved alongside its captions (#536),
    // one name per cue in cue order. An import has none. A list that does not
    // match the cue count is dropped rather than applied to the wrong lines:
    // the project then exports uncoloured until the next Regenerate.
    function populateCaptionEditorFromVtt(vtt, speakers) {
      const data = [];
      vtt = vtt.replace("WEBVTT\n\n","");
      vtt = vtt.replaceAll("\n\n","\n");

      let lines = vtt.split('\n');
      let start, stop, text;

      lines.forEach((line, index) => {
        let lineIsNumber = !isNaN(line.trim().replace(' --> ','').replaceAll('.','').replaceAll(':',''));
        if (lineIsNumber === true && line.indexOf(' --> ') === 12 && line.length === 29) {
          if (index > 0) {
            data.push({start, stop, text});
          }
          start = line.split(' --> ')[0];
          stop = line.split(' --> ')[1].trim();
          text = "";
        } else {
          text += line.trim() + "\n";
        }
      });

      // The loop only pushes a cue when it meets the NEXT timestamp line, so
      // the last one was never pushed — every VTT lost its final caption, and
      // a single-cue VTT produced no rows at all (#513). Not cosmetic: the
      // editor is what generateCaptionsFromCaptionEditor rebuilds the VTT
      // from, so the dropped cue vanished for good on the next save.
      if (start !== undefined) {
        data.push({start, stop, text});
      }

      if (Array.isArray(speakers) && speakers.length === data.length) {
        data.forEach((cap, i) => {
          if (typeof speakers[i] === 'string' && speakers[i] !== '') cap.speaker = speakers[i];
        });
      }

      populateCaptionEditor(data);

      // (Until #506 this function raised the divergence notice — so opening
      // any curated project, including at boot, threw an alert. The notice
      // now raises on caption-editor ENTRY (editor-core), where it's
      // relevant; a real modal at open would block the whole app.)
    }

    const cap2 = caption();
    const bootLines = typeof captionLineLengths === 'function' ? captionLineLengths() : { max: 32, min: 21 };
    let subs = cap2.init("hypertranscript", "hyperplayer", String(bootLines.max), String(bootLines.min)); // transcript Id, player Id, max chars, min chars for caption line
    
    const countSeconds = (str) => {
      const [hh = '0', mm = '0', ss = '0'] = (str || '0:0:0').split(':');
      const hour = parseInt(hh, 10) || 0;
      const minute = parseInt(mm, 10) || 0;
      const second = parseFloat(ss);
      return (hour*3600) + (minute*60) + (second);
    };

    function playClip(elem) {

      let startTime = countSeconds(elem.parentElement.parentElement.querySelector('.start').value);
      let endTime = countSeconds(elem.parentElement.parentElement.querySelector('.end').value);
      let duration = endTime - startTime;

      document.querySelector('video').currentTime = startTime;
      document.querySelector('video').play();

      let clipTimer = setInterval(function(){
        if(document.querySelector('video').currentTime > endTime){
          document.querySelector('video').pause();
          clearInterval(clipTimer);
        }
      },100);
    }

    function seekTo(elem) {
      let seekTime = countSeconds(elem.nextElementSibling.value);
      if (elem.className == "play-end") {
        seekTime -= 0.1;
      }
      document.querySelector('video').currentTime = seekTime;
    }

    // Picture-in-picture: pops the video into a floating window so it stays
    // visible while scrolling the transcript. Only meaningful for media with a
    // video track, so the button disables itself for audio-only sources.
    //
    // Two APIs, and WebKit is the reason (#600). It answers
    // document.pictureInPictureEnabled with true and offers
    // requestPictureInPicture(), then rejects the call with NotSupportedError
    // — "The video element does not support the Picture-in-Picture mode." Its
    // working API is the presentation-mode one, so that is tried FIRST
    // wherever it exists rather than kept as a fallback: a browser that
    // implements it means it.
    const webkitPip = (video) =>
      typeof video.webkitSetPresentationMode === 'function'
      && typeof video.webkitSupportsPresentationMode === 'function';

    function togglePictureInPicture() {
      const video = document.querySelector('#hyperplayer');
      if (video === null) {
        return;
      }
      if (webkitPip(video)) {
        try {
          video.webkitSetPresentationMode(
            video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture',
          );
          return;
        } catch (e) {
          console.warn('Picture-in-picture failed:', e); // fall through to the standard call
        }
      }
      const action = document.pictureInPictureElement
        ? document.exitPictureInPicture()
        : video.requestPictureInPicture();
      Promise.resolve(action).catch((e) => console.warn('Picture-in-picture failed:', e));
    }

    // Audio-only: hide the video frame for audio files or to focus on the
    // transcript. Playback is driven by the docked play bar, so the video stays
    // in the DOM (audio keeps playing) — only its picture is hidden.
    function toggleAudioOnly(btn) {
      const video = document.querySelector('#hyperplayer');
      if (video === null) {
        return;
      }
      const on = video.classList.toggle('audio-only');
      // body.video-collapsed drives everything in CSS: #player-frame slides
      // shut (animated max-height/opacity — no display:none pop), the controls
      // row aligns with the navbar, and the Recents card aligns with the
      // transcript card (#375). Audio keeps playing throughout.
      document.body.classList.toggle('video-collapsed', on);
      btn.classList.toggle('btn-active', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.setAttribute('data-tip', on ? 'Show video' : 'Audio only');
    }

    // Docked play bar: a play/pause button + a full-width seek bar below the
    // transcript, an alternative to the player's own (cramped) native scrubber.
    function togglePlay() {
      const video = document.querySelector('#hyperplayer');
      if (video === null) {
        return;
      }
      if (video.paused) {
        video.play();
      } else {
        video.pause();
      }
    }

    function toggleMute() {
      const video = document.querySelector('#hyperplayer');
      if (video === null) {
        return;
      }
      video.muted = !video.muted;
    }

    (function initPlaybar() {
      const video = document.querySelector('#hyperplayer');
      const seek = document.querySelector('#playbar-seek');
      const playIcon = document.querySelector('#playbar-play-icon');
      const pauseIcon = document.querySelector('#playbar-pause-icon');
      const timeEl = document.querySelector('#playbar-time');
      const volume = document.querySelector('#playbar-volume');
      const volumeIcon = document.querySelector('#playbar-volume-icon');
      const muteIcon = document.querySelector('#playbar-mute-icon');
      const rate = document.querySelector('#playbar-rate');
      if (video === null || seek === null) {
        return;
      }

      // Playback rate (discrete steps; 1× default). The old side-panel #pbr
      // control is gone, so this select is the sole controller.
      if (rate !== null) {
        video.playbackRate = parseFloat(rate.value);
        rate.addEventListener('change', () => {
          video.playbackRate = parseFloat(rate.value);
        });
        video.addEventListener('ratechange', () => {
          const v = String(video.playbackRate);
          if (Array.from(rate.options).some((o) => o.value === v)) {
            rate.value = v;
          }
        });
      }
      const SEEK_MAX = 1000;
      let seeking = false;

      const fmt = (s) => {
        if (!isFinite(s) || s < 0) {
          return '0:00';
        }
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return m + ':' + String(sec).padStart(2, '0');
      };

      const syncFromVideo = () => {
        if (!seeking && video.duration > 0) {
          seek.value = String(Math.round((video.currentTime / video.duration) * SEEK_MAX));
        }
        timeEl.textContent = fmt(video.currentTime) + ' / ' + fmt(video.duration);
      };

      const overlayPlayIcon = document.querySelector('#media-overlay-play-icon');
      const overlayPauseIcon = document.querySelector('#media-overlay-pause-icon');
      const playerFrame = document.querySelector('#player-frame');
      const reflectPlayState = () => {
        const playing = !video.paused && !video.ended;
        playIcon.style.display = playing ? 'none' : '';
        pauseIcon.style.display = playing ? '' : 'none';
        // mirror on the media overlay; keep the overlay visible while paused
        if (overlayPlayIcon) { overlayPlayIcon.style.display = playing ? 'none' : ''; }
        if (overlayPauseIcon) { overlayPauseIcon.style.display = playing ? '' : 'none'; }
        if (playerFrame) { playerFrame.classList.toggle('is-paused', !playing); }
      };

      video.addEventListener('timeupdate', syncFromVideo);
      video.addEventListener('loadedmetadata', syncFromVideo);
      video.addEventListener('durationchange', syncFromVideo);
      video.addEventListener('play', reflectPlayState);
      video.addEventListener('pause', reflectPlayState);
      video.addEventListener('ended', reflectPlayState);
      // Swapping src (every project switch) stops playback WITHOUT a pause
      // event — the load algorithm fires 'emptied' instead. Without this, a
      // switch away from a playing video left the pause button showing over
      // a video that wasn't playing.
      video.addEventListener('emptied', reflectPlayState);

      const reflectVolume = () => {
        const silent = video.muted || video.volume === 0;
        volumeIcon.style.display = silent ? 'none' : '';
        muteIcon.style.display = silent ? '' : 'none';
        volume.value = String(Math.round((video.muted ? 0 : video.volume) * 100));
      };
      video.addEventListener('volumechange', reflectVolume);
      volume.addEventListener('input', () => {
        video.muted = false;
        video.volume = volume.value / 100;
      });

      // Live scrub: move playback AND drive the transcript (highlight + scroll)
      // as the user drags. HyperaudioLite only runs its play-head loop while
      // playing, so we call checkPlayHead() to update the transcript when
      // scrubbing — including while paused, when that loop is stopped.
      // Move playback to the scrubbed position. Setting currentTime fires the
      // media 'seeked' event, which hyperaudio-lite (>= 2.4.x) handles itself to
      // follow the transcript (highlight + scroll), so we don't reconcile here.
      const scrubTo = (commit) => {
        if (video.duration > 0) {
          const t = (seek.value / SEEK_MAX) * video.duration;
          video.currentTime = t;
          timeEl.textContent = fmt(t) + ' / ' + fmt(video.duration);
        }
        if (commit) {
          seeking = false;
        }
      };

      seek.addEventListener('input', () => {
        seeking = true;
        scrubTo(false);
      });
      seek.addEventListener('change', () => {
        scrubTo(true);
      });

      syncFromVideo();
      reflectPlayState();
      reflectVolume();
    })();

    (function initPictureInPicture() {
      const btn = document.querySelector('#pip-btn');
      const video = document.querySelector('#hyperplayer');
      if (btn === null || video === null) {
        return;
      }
      // Hide only when NEITHER API is on offer; WebKit has the presentation-mode
      // one whatever document.pictureInPictureEnabled says (#600).
      const standardPip = document.pictureInPictureEnabled && !video.disablePictureInPicture;
      if (!standardPip && !webkitPip(video)) {
        btn.style.display = 'none';   // unsupported – don't show a dead button
        return;
      }
      const refresh = () => {
        const hasVideo = video.videoWidth > 0;
        btn.classList.toggle('btn-disabled', !hasVideo);
        btn.setAttribute('aria-disabled', String(!hasVideo));
        btn.setAttribute('data-tip', hasVideo ? 'Picture-in-picture' : 'Picture-in-picture (video only)');
      };
      refresh();
      video.addEventListener('loadedmetadata', refresh);
      video.addEventListener('emptied', refresh);
    })();

    function addCaption(elem) {
      // Initialize the DOM parser and get the template
      let parser = new DOMParser();
      let html = document.querySelector('#caption-template-holder').innerHTML;
      let template = parser.parseFromString(html, "text/html");

      let captionTempl = template.querySelector('#caption-template').cloneNode(true);
      captionTempl.getElementsByClassName('line1')[0].value = "";
      captionTempl.getElementsByClassName('line2')[0].value = "";
      captionTempl.getElementsByClassName('start')[0].value = "00:00:00.000";
      captionTempl.getElementsByClassName('end')[0].value = "00:00:00.000";
      captionTempl.classList.add('caption-new');
      // Inherit the speaker of the row this one is inserted after (#536): a
      // caption added inside someone's turn belongs to them. Merge needs no
      // such rule — the surviving row keeps its own, and a cue can only be one
      // colour — and delete none at all.
      const above = elem.parentElement.parentNode;
      const inherited = above.getAttribute('data-speaker');
      if (inherited !== null && inherited !== '') captionTempl.setAttribute('data-speaker', inherited);
      above.insertAdjacentElement('afterend', captionTempl);
      // Remove animation class after animation completes
      setTimeout(() => {
        captionTempl.classList.remove('caption-new');
      }, 300);
      makeCaptionEditorActive();
    }

    function deleteCaption(elem) {
      let thisCaption = elem.parentNode.parentNode;
      thisCaption.parentNode.removeChild(thisCaption);
      makeCaptionEditorActive();
    }

    function mergeCaption(elem) {
      let thisCaption = elem.parentNode.parentNode;
      let belowCaption = thisCaption.nextElementSibling;

      thisCaption.querySelector('.end').value = belowCaption.querySelector('.end').value;
      thisCaption.querySelector('.line2').value += 
        ` ${belowCaption.querySelector('.line1').value.toString()} ${belowCaption.querySelector('.line2').value.toString()}`;

      belowCaption.parentNode.removeChild(belowCaption);
      makeCaptionEditorActive();
    }

    function captionChange() {
      makeCaptionEditorActive();
    }

    // The one door every caption edit passes through — typing (captionChange),
    // insert, merge and delete all land here. Typing alone reached the save
    // module, because its inputs fire a real `input` event that the module's
    // delegation picks up inside #caption-editor; the three structural buttons
    // are onclick handlers that mutate the caption list without any input
    // event, so their changes — and the updateCaptionsFromTranscript flip
    // below, which is itself persisted project state — left the project
    // looking clean and were lost on close (#505). Announcing it here covers
    // all four in one place rather than chasing three onclick handlers.
    function makeCaptionEditorActive() {
      updateCaptionRates();   // a word added or cut, a time changed, a merge (#639)
      updateCaptionsFromTranscript = false;
      document.querySelector('#regenerate-btn').classList.remove("btn-disabled");
      generateCaptionsFromCaptionEditor();
      document.dispatchEvent(new CustomEvent('hyperaudioCaptionsEdited'));
    }

    function generateCaptionsFromCaptionEditor() {

      let vttCaptions = "WEBVTT\n\n";
      let srtCaptions = "";

      document.querySelectorAll('.caption').forEach((caption, index) => {
        if (caption.querySelector('.start').value.length > 0){
          vttCaptions += caption.querySelector('.start').value + " --> " + caption.querySelector('.end').value + "\n";
          vttCaptions += caption.querySelector('.line1').value + "\n";
          if (caption.querySelector('.line2').value.length > 0) {
            vttCaptions += caption.querySelector('.line2').value + "\n";
          }
          vttCaptions += "\n";

          srtCaptions += (index + 1) + "\n";
          srtCaptions += convertTimecodeToSrt(caption.querySelector('.start').value) + " --> " + convertTimecodeToSrt(caption.querySelector('.end').value) + "\n";
          srtCaptions += caption.querySelector('.line1').value + "\n";
          if (caption.querySelector('.line2').value.length > 0) {
            srtCaptions += caption.querySelector('.line2').value + "\n";
          }
          srtCaptions += "\n";
        }
      });

      let track = document.querySelector('#hyperplayer-vtt');
      track.src = "data:text/vtt,"+encodeURIComponent(vttCaptions);

      document.querySelector('#download-vtt').setAttribute('href', "data:text/vtt,"+encodeURIComponent(vttCaptions));
      document.querySelector('#download-srt').setAttribute('href', "data:text/srt,"+encodeURIComponent(srtCaptions));
    }

    // The speaker of each caption, in cue order (#536), for the coloured
    // download and for the project to save. Rows are skipped exactly as the
    // writer above skips them — no in time, no cue — so the list always lines
    // up index for index with the cues in the file.
    //
    // Live rows when the caption editor is on screen; otherwise the cache,
    // which is the same markup as a string (the caption pass at transcription
    // time builds its rows in a detached holder). A caption with no recorded
    // speaker contributes an empty string, so its position is still held.
    function captionSpeakerList() {
      let rows = document.querySelectorAll('#captions-display .caption');
      if (rows.length === 0 && typeof captionCache === 'string' && captionCache !== '') {
        try {
          rows = new DOMParser().parseFromString(captionCache, 'text/html')
            .querySelectorAll('#captions-display .caption');
        } catch (e) {
          return [];
        }
      }
      const out = [];
      rows.forEach((row) => {
        const start = row.querySelector('.start');
        const value = start === null ? '' : (start.value || start.getAttribute('value') || '');
        if (String(value).length === 0) return;
        out.push(row.getAttribute('data-speaker') || '');
      });
      return out;
    }
    window.captionSpeakerList = captionSpeakerList;

    function getTranscriptData() {
      let transcriptElement = document.querySelector('#hypertranscript');

      let transcriptData = null;

      if (transcriptElement !== null) {
        transcriptData = transcriptElement.innerHTML;
      } else {
        const parser = new DOMParser();
        transcriptData = parser.parseFromString(transcriptCache.innerHTML, 'text/html').querySelector('#hypertranscript').innerHTML;
      }

      return transcriptData.replace(/ class=".*?"/g, '');

    }

    function convertTimecodeToSrt(timecode) {
      //the same as VTT format but milliseconds separated by a comma
      return timecode.substring(0,8) + "," + timecode.substring(9,12);
    }



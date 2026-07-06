/* Extracted verbatim from index.html (#334) — loaded as a classic script in the same document order. */
    window.document.addEventListener('hyperaudioPopulateCaptionEditor', populateCaptionEditor, false);

    function restoreTranscript() {
      document.querySelector('.transcript-holder').innerHTML = "";
      let hypertranscript = transcriptCache.querySelector("#hypertranscript");
      document.querySelector('.transcript-holder').appendChild(hypertranscript);
      hyperaudio();
    }

    function populateCaptionEditor(data) {

      let holder = null;

      // only actually inject the caption HTML if we are in "captionMode"
      if (captionMode === true) {
        holder = document.querySelector('.transcript-holder');
      } else {
        holder = document.createElement('div');
        holder.className = 'transcript-holder';
      }
      

      holder.innerHTML = '<div class="modal-action"><label id="regenerate-float-btn" for="regenerate-captions-modal" class="fixed top-20 right-8 btn btn-outline btn-primary" >Regenerate <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-list-restart"><path d="M21 6H3"></path><path d="M7 12H3"></path><path d="M7 18H3"></path><path d="M12 18a5 5 0 0 0 9-3 4.5 4.5 0 0 0-4.5-4.5c-1.33 0-2.54.54-3.41 1.41L11 14"></path><path d="M11 10v4h4"></path></svg></label></div>';

      if (captionCache === null ) {
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

    function populateCaptionEditorFromVtt(vtt) {
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

      populateCaptionEditor(data);

      if (updateCaptionsFromTranscript === false && localStorage.getItem("noCaptionAlert") !== "true") {
        document.querySelector('#captionsource-alert').style.visibility = 'visible';
      }
    }

    const cap2 = caption();
    let subs = cap2.init("hypertranscript", "hyperplayer", '37' , '21'); // transcript Id, player Id, max chars, min chars for caption line
    
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
    function togglePictureInPicture() {
      const video = document.querySelector('#hyperplayer');
      if (video === null) {
        return;
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
      if (!document.pictureInPictureEnabled || video.disablePictureInPicture) {
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
      elem.parentElement.parentNode.insertAdjacentElement('afterend', captionTempl);
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

    function makeCaptionEditorActive() {
      updateCaptionsFromTranscript = false;
      document.querySelector('#regenerate-btn').classList.remove("btn-disabled");
      generateCaptionsFromCaptionEditor();
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

      document
      .querySelector("#download-hypertranscript")
      .setAttribute(
        "href",
        "data:text/html," +
          encodeURIComponent(
            hyperaudioTemplate
              .replace("{hypertranscript}", getTranscriptData())
              .replace("{sourcemedia}", document.querySelector("#hyperplayer").src)
              .replace("{sourcevtt}", track.src)
          )
      );

      document.querySelector('#download-vtt').setAttribute('href', "data:text/vtt,"+encodeURIComponent(vttCaptions));
      document.querySelector('#download-srt').setAttribute('href', "data:text/srt,"+encodeURIComponent(srtCaptions));
    }

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



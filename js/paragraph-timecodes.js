/*! (C) The Hyperaudio Project. AGPL 3.0 @license: https://www.gnu.org/licenses/agpl-3.0.en.html */
/*! Hyperaudio Lite Editor - paragraph-level timecodes. @version 0.6.20 */

// Self-contained, modular display feature. To remove it entirely: delete this
// file, its <script> tag in index.html, and the #show-timecodes checkbox.
//
// Shows a small timecode at the start of each transcript paragraph, derived
// from that paragraph's first word (data-m). Clicking it seeks the player.
// Toggled by the #show-timecodes checkbox (off by default).
//
// IMPORTANT: the timecodes are rendered OUTSIDE the contenteditable, as
// absolutely-positioned elements inside .transcript-holder (the scroll
// container that wraps #hypertranscript). Because they are absolute children
// of the scroll container, they scroll with the content natively. Being
// outside #hypertranscript means they can't be deleted or selected while
// editing, are never part of a strikeout/skip selection, and never appear in
// any export (captions, JSON, ionosphere, interactive HTML). Positions are
// recomputed only when the transcript layout changes (edits, reflow, resize,
// sidebar toggle) via a ResizeObserver - never on scroll.

(function () {
  'use strict';

  let enabled = false;
  let rafPending = false;
  let busyObs = null;
  let observedTranscript = null;

  function formatTimecode(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const ss = String(seconds).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function holderEl() {
    return document.querySelector('.transcript-holder');
  }
  function transcriptEl() {
    return document.getElementById('hypertranscript');
  }
  function firstWordOf(paragraph) {
    return paragraph.querySelector('span[data-m]:not(.speaker)');
  }

  function clearTimecodes(holder) {
    holder.querySelectorAll(':scope > .para-timecode').forEach((el) => el.remove());
  }

  function reposition() {
    const holder = holderEl();
    const transcript = transcriptEl();
    if (!holder || !transcript) {
      return;
    }
    // While transcribing/processing, setTranscriptBusy() marks the transcript
    // aria-busy="true" (the old timed transcript may still be in the DOM) - hide
    // timecodes in that state, and whenever the container holds no timed words.
    const busy = transcript.getAttribute('aria-busy') === 'true';
    const paragraphs = [];
    if (enabled && !busy) {
      transcript.querySelectorAll('p').forEach((paragraph) => {
        const firstWord = firstWordOf(paragraph);
        if (!firstWord) {
          return;
        }
        const ms = parseInt(firstWord.getAttribute('data-m'), 10);
        if (!isNaN(ms)) {
          paragraphs.push({ paragraph, ms });
        }
      });
    }

    // Off, or nothing to label yet (e.g. transcribing) -> no labels.
    if (paragraphs.length === 0) {
      clearTimecodes(holder);
      return;
    }

    // Reuse existing timecode elements where possible (cheap reflow updates);
    // only rebuild when the paragraph count changes.
    let tcs = Array.prototype.slice.call(
      holder.querySelectorAll(':scope > .para-timecode'),
    );
    if (tcs.length !== paragraphs.length) {
      clearTimecodes(holder);
      tcs = paragraphs.map(() => {
        const tc = document.createElement('div');
        tc.className = 'para-timecode';
        holder.appendChild(tc);
        return tc;
      });
    }

    // Place each label in the left margin, OUTSIDE the fixed-width transcript, so
    // the reading column never shifts. The transcript is centred in the wider
    // holder; right-anchor the label to end just before the transcript's left
    // edge, and top-align it to the paragraph's first line.
    const holderRect = holder.getBoundingClientRect();
    const transcriptRect = transcript.getBoundingClientRect();
    const scrollTop = holder.scrollTop;
    const GAP = 12;
    const rightOffset = holderRect.width - (transcriptRect.left - holderRect.left) + GAP;
    // Match the paragraph's line-height so the small label aligns with its first line.
    const lineHeight = getComputedStyle(paragraphs[0].paragraph).lineHeight;
    paragraphs.forEach((item, i) => {
      const tc = tcs[i];
      const label = formatTimecode(item.ms);
      if (tc.textContent !== label) {
        tc.textContent = label;
        tc.title = `Jump to ${label}`;
      }
      tc.dataset.ms = String(item.ms);
      tc.style.right = `${rightOffset}px`;
      tc.style.lineHeight = lineHeight;
      const top = item.paragraph.getBoundingClientRect().top - holderRect.top + scrollTop;
      tc.style.top = `${top}px`;
    });
  }

  function scheduleReposition() {
    if (rafPending) {
      return;
    }
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      reposition();
    });
  }

  function trigger() {
    if (enabled) {
      scheduleReposition();
    }
  }

  // The transcript element is replaced wholesale when a file loads (Recents wipes
  // .transcript-holder). Re-bind the per-transcript observers to the current one.
  function attachToTranscript() {
    const transcript = transcriptEl();
    if (transcript === observedTranscript) {
      return;
    }
    if (observedTranscript) {
      observedTranscript.removeEventListener('blur', trigger, true);
    }
    if (busyObs) {
      busyObs.disconnect();
      busyObs = null;
    }
    observedTranscript = transcript;
    if (!transcript) {
      return;
    }
    // Edits don't resize the fixed-size transcript box, so refresh on blur.
    transcript.addEventListener('blur', trigger, true);
    // Transcribe toggles aria-busy without a size change.
    if (typeof MutationObserver !== 'undefined') {
      busyObs = new MutationObserver(trigger);
      busyObs.observe(transcript, { attributes: true, attributeFilter: ['aria-busy'] });
    }
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = [
      // .transcript-holder is already position:absolute, so it is the containing
      // block for these absolute children, which sit in its left margin (outside
      // the fixed-width transcript) - no padding on the transcript, no text shift.
      '.transcript-holder .para-timecode {',
      '  position: absolute;',
      '  font-size: 0.85rem;',
      '  font-variant-numeric: tabular-nums;',
      '  color: #8a8a8a;',
      '  cursor: pointer;',
      '  white-space: nowrap;',
      '  -webkit-user-select: none;',
      '  user-select: none;',
      '  z-index: 1;',
      '}',
      '.transcript-holder .para-timecode:hover {',
      '  color: var(--p, #1f6feb);',
      '  text-decoration: underline;',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function init() {
    injectStyles();

    const checkbox = document.getElementById('show-timecodes');
    if (checkbox) {
      enabled = checkbox.checked;
      checkbox.addEventListener('change', () => {
        enabled = checkbox.checked;
        reposition();
      });
    }

    const holder = holderEl();
    if (holder) {
      // Delegated seek (elements are reused across repositions).
      holder.addEventListener('click', (e) => {
        const tc = e.target.closest && e.target.closest('.para-timecode');
        if (!tc) {
          return;
        }
        const ms = parseInt(tc.dataset.ms, 10);
        const player = document.getElementById('hyperplayer');
        if (player && !isNaN(ms)) {
          // Nudge just past the first word's start so the library activates and
          // scrolls to this paragraph, not the previous one (boundary off-by-one).
          player.currentTime = ms / 1000 + 0.01;
        }
      });
    }

    if (holder && typeof ResizeObserver !== 'undefined') {
      // The transcript box is fixed-size, but the holder resizes on window
      // resize and sidebar collapse, which shifts the centred transcript and
      // its margin labels - so observe the holder, not the transcript.
      new ResizeObserver(trigger).observe(holder);
    }
    if (holder && typeof MutationObserver !== 'undefined') {
      // The transcript content is replaced by Recents (.transcript-holder wiped),
      // by transcription, and by imports (#hypertranscript.innerHTML = ...). Watch
      // the subtree for element add/remove and rebuild. The nodeType===1 guard
      // skips plain typing (text-node mutations); the .para-timecode guard skips
      // our own label churn (so this can't loop).
      new MutationObserver((mutations) => {
        const structural = mutations.some((m) =>
          [].concat(
            Array.prototype.slice.call(m.addedNodes),
            Array.prototype.slice.call(m.removedNodes),
          ).some((n) => n.nodeType === 1 && !n.classList.contains('para-timecode')),
        );
        if (!structural) {
          return;
        }
        attachToTranscript();
        trigger();
      }).observe(holder, { childList: true, subtree: true });
    }

    window.addEventListener('resize', trigger);
    document.addEventListener('hyperaudioInit', trigger, false);

    attachToTranscript();

    if (enabled) {
      reposition();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/**
 * word-vtt.js
 * (C) The Hyperaudio Project
 * @version 0.7.7 — last changed in release 0.7.7
 * @license MIT
 *
 * Word-level ("karaoke") WebVTT export (#387, part 1).
 *
 * Standard caption VTT (js/caption.js) groups words into phrase-length cues and
 * emits only cue-level timing. This module instead emits cues that carry
 * per-word timing via inline WebVTT timestamp tags:
 *
 *     00:00:01.200 --> 00:00:02.640
 *     <00:00:01.200>So <00:00:01.550>if <00:00:01.900>you're …
 *
 * Browsers highlight these live during playback, and the burn-in renderer
 * (#387 part 2) uses them for per-word karaoke animation.
 *
 * Source is the live #hypertranscript DOM (per-word data-m/data-d), so the
 * output reflects the user's edits. caption.js is left untouched — it is
 * vendored verbatim from upstream.
 *
 * Loaded as a plain <script>; exposes `generateWordVtt` as a global and
 * self-wires the #download-vtt-words menu link. Also exported for unit tests.
 */

(function () {
  const DEFAULTS = {
    maxWords: 5,    // words per karaoke chunk
    maxGap: 0.8,    // seconds; a longer pause starts a new chunk
    selector: '#hypertranscript',
  };

  // seconds -> HH:MM:SS.mmm
  function formatTimestamp(t) {
    if (!(t >= 0)) t = 0;
    const hh = Math.floor(t / 3600);
    const mm = Math.floor((t % 3600) / 60);
    const ss = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}.${pad(ms, 3)}`;
  }

  // Pull the ordered word list out of a transcript root. Speaker labels carry a
  // data-m too, so they are skipped; empty/whitespace spans are ignored.
  function readWords(root) {
    const words = [];
    root.querySelectorAll('[data-m]').forEach((span) => {
      if (span.classList.contains('speaker')) return;
      const text = (span.textContent || '').trim();
      if (!text) return;
      const start = parseInt(span.getAttribute('data-m'), 10) / 1000;
      if (isNaN(start)) return;
      let dur = parseInt(span.getAttribute('data-d'), 10) / 1000;
      if (isNaN(dur) || dur < 0) dur = 0;
      words.push({ start, end: start + dur, text });
    });
    // Fill missing/zero durations from the next word's start so every word has a
    // non-degenerate span for the renderer to sweep across.
    for (let i = 0; i < words.length; i++) {
      if (!(words[i].end > words[i].start)) {
        words[i].end = i + 1 < words.length
          ? Math.max(words[i].start, words[i + 1].start)
          : words[i].start + 0.4;
      }
    }
    return words;
  }

  // Break the flat word list into short karaoke chunks: a new chunk starts once
  // the current one hits maxWords or a pause longer than maxGap opens up.
  function chunkWords(words, maxWords, maxGap) {
    const chunks = [];
    let cur = [];
    for (let i = 0; i < words.length; i++) {
      if (cur.length > 0) {
        const gap = words[i].start - cur[cur.length - 1].end;
        if (cur.length >= maxWords || gap > maxGap) {
          chunks.push(cur);
          cur = [];
        }
      }
      cur.push(words[i]);
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  // Resolve options.source (a selector string, an element, or unset → default
  // selector) to a transcript root element, or a falsy value if none.
  function resolveRoot(opts) {
    if (typeof opts.source === 'string' || opts.source == null) {
      return typeof document !== 'undefined' && document.querySelector(opts.source || opts.selector);
    }
    return opts.source;
  }

  /**
   * Build the word chunks from a transcript root — the shared unit behind both
   * the VTT export and the burn-in renderer (#387 part 2). Each chunk is an
   * array of `{ text, start, end }` (seconds). Empty array if no words.
   * @param {Object} [options] maxWords, maxGap, source (see generateWordVtt)
   * @returns {Array<Array<{text:string,start:number,end:number}>>}
   */
  function buildWordChunks(options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const root = resolveRoot(opts);
    if (!root) return [];
    const words = readWords(root);
    if (!words.length) return [];
    return chunkWords(words, opts.maxWords, opts.maxGap);
  }

  /**
   * Build word-level ("karaoke") WebVTT from the live transcript.
   * @param {Object} [options]
   * @param {number} [options.maxWords=5]  words per chunk
   * @param {number} [options.maxGap=0.8]  seconds; longer pause splits a chunk
   * @param {string|Element} [options.source='#hypertranscript'] transcript root
   * @returns {string} a WebVTT document (just the header if there are no words)
   */
  function generateWordVtt(options) {
    const chunks = buildWordChunks(options);
    let vtt = 'WEBVTT\n';
    chunks.forEach((chunk) => {
      const start = chunk[0].start;
      const end = chunk[chunk.length - 1].end;
      const line = chunk
        .map((w) => `<${formatTimestamp(w.start)}>${w.text}`)
        .join(' ');
      vtt += `\n${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${line}\n`;
    });
    return vtt;
  }

  // Self-wire the menu link: generate on click so the download always reflects
  // the current transcript state. Drive the download from a throwaway anchor
  // rather than mutating this link's href mid-click, which is more reliable
  // across browsers.
  function wireDownloadLink() {
    const link = typeof document !== 'undefined' && document.getElementById('download-vtt-words');
    if (!link) return;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const vtt = generateWordVtt();
      const blob = new Blob([vtt], { type: 'text/vtt' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = link.getAttribute('download') || 'hyperaudio.words.vtt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', wireDownloadLink);
    } else {
      wireDownloadLink();
    }
    window.generateWordVtt = generateWordVtt;
    window.hyperaudioWordChunks = buildWordChunks;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { generateWordVtt, buildWordChunks, formatTimestamp, readWords, chunkWords };
  }
})();

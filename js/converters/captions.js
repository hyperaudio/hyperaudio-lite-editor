/**
 * converters/captions.js
 * (C) The Hyperaudio Project
 * @version 1.3.44 — last changed in release 1.3.44
 * @license AGPL-3.0-only
 *
 * A caption file, SRT or WebVTT, as transcript markup (#751). The file's
 * cues are read, each cue's duration is spread over its words, and the
 * paragraphs are placed by the one rule every engine and import share
 * (js/paragraph-rule.js, #743). The import dialogs
 * (js/hyperaudio-lite-editor-export.js) read the file and put the result on
 * the page, and keep `srtToHtml` and `vttToHtml` as the globals a native
 * host calls. Nothing here touches the page.
 *
 * Unlike the engine converters this one renders its own markup rather than
 * going through jsonToHTML: a cue's text may carry <b>, <i>, <u>, <s> and
 * <font> from the file, which jsonToHTML would escape, and a caption's words
 * have no durations of their own.
 */
(function (root) {
  'use strict';

  const paragraphRule = () => {
    if (root && typeof root.hyperaudioParagraphStarts === 'function') return root.hyperaudioParagraphStarts;
    if (typeof require === 'function') {
      try { return require('../paragraph-rule.js').paragraphStarts; } catch (e) { return null; }
    }
    return null;
  };

  // A caption file's words as transcript markup, with paragraphs placed by
  // the shared rule. A caption file has no word timings: each cue's duration
  // is spread over its words, so within a cue the words follow on without a
  // gap, and only the space between one cue's end and the next cue's start
  // is a real pause. Each word therefore ends where the next word in its cue
  // starts, and the last word of a cue at the cue's end.
  function captionWordsToHtml(captionWords) {
    const plain = (html) => String(html).replace(/<[^>]*>/g, '');
    const words = captionWords.map((w, i) => ({
      start: w.ms / 1000,
      end: w.lastInCue || i === captionWords.length - 1 ? w.cueEnd : captionWords[i + 1].ms / 1000,
      text: plain(w.html),
    }));
    const rule = paragraphRule();
    const starts = rule !== null ? rule(words) : new Set();
    let html = '<article><section><p>';
    captionWords.forEach((w, i) => {
      if (starts.has(i)) html += '</p><p>';
      html += '<span data-m="' + w.ms + '">' + w.html + ' </span>';
    });
    return html + '</p></section></article>';
  }

  // One cue's text as timed words: the cue's duration shared out in equal
  // steps, each word a step after the last.
  function cueWords(text, start, end, captionWords) {
    const swords = text.split(' ');
    const sduration = end - start;
    const stimeStep = sduration / swords.length;
    for (let si = 0, sl = swords.length; si < sl; ++si) {
      const stime = Math.round((start + si * stimeStep) * 1000);
      captionWords.push({ ms: stime, html: swords[si], cueEnd: end, lastInCue: si === sl - 1 });
    }
  }

  // Cue text as it may appear: SSA-style tags stripped, HTML escaped, and the
  // supported styling tags (font, b, u, i, s) let back through.
  // Modified version of regex from Phil Haack's blog: http://haacked.com/archive/2004/10/25/usingregularexpressionstomatchhtml.aspx
  // Later modified by kev: http://kevin.deldycke.com/2007/03/ultimate-regular-expression-for-html-tag-parsing-with-php/
  function cueText(joined) {
    let text = joined.replace(/\{(\[\w]+\(?([\w\d]+,?)+\)?)+\}/gi, '');
    text = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return text.replace(
      /&lt;(\/?(font|b|u|i|s))((\s+(\w|\w[\w\-]*\w)(\s*=\s*(?:\".*?\"|'.*?'|[^'\">\s]+))?)+\s*|\s*)(\/?)&gt;/gi,
      '<$1$3$7>'
    );
  }

  /**
   * An SRT file's text as transcript markup.
   * @param {string} data - the file's text
   * @returns {string}
   */
  function srt(data) {
    let i = 0;
    let len = 0;
    let idx = 0;
    let lines;
    let time;
    let text;
    let sub;

    // Simple function to convert HH:MM:SS,MMM or HH:MM:SS.MMM to SS.MMM
    // Assume valid, returns 0 on error
    const toSeconds = function (t_in) {
      const t = t_in.split(':');
      try {
        let s = t[2].split(',');
        // Just in case a . is decimal seperator
        if (s.length === 1) {
          s = t[2].split('.');
        }
        return (
          parseFloat(t[0], 10) * 3600 +
          parseFloat(t[1], 10) * 60 +
          parseFloat(s[0], 10) +
          parseFloat(s[1], 10) / 1000
        );
      } catch (e) {
        return 0;
      }
    };

    const captionWords = [];   // { ms, html, cueEnd, lastInCue }, in order

    // Split on line breaks
    lines = data.split(/(?:\r\n|\r|\n)/gm);
    len = lines.length;

    for (i = 0; i < len; i++) {
      sub = {};
      text = [];

      sub.id = parseInt(lines[i++], 10);

      // Split on '-->' delimiter, trimming spaces as well
      try {
        time = lines[i++].split(/[\t ]*-->[\t ]*/);
      } catch (e) {
        console.log('Warning. Possible issue on line ' + i + ": '" + lines[i] + "'.");
        break;
      }

      sub.start = toSeconds(time[0]);

      // So as to trim positioning information from end
      if (!time[1]) {
        if (typeof alert === 'function') alert('Warning. Issue on line ' + i + ": '" + lines[i] + "'.");
        return;
      }
      idx = time[1].indexOf(' ');
      if (idx !== -1) {
        time[1] = time[1].substr(0, idx);
      }
      sub.end = toSeconds(time[1]);

      // Build single line of text from multi-line subtitle in file
      while (i < len && lines[i]) {
        text.push(lines[i++]);
      }

      // Join into 1 line, SSA-style linebreaks, then the tags
      sub.text = cueText(text.join('\\N')).replace(/\\N/gi, ' ');

      cueWords(sub.text, sub.start, sub.end, captionWords);
    }

    return captionWordsToHtml(captionWords);
  }

  /**
   * A WebVTT file's text as transcript markup.
   * @param {string} data - the file's text
   * @returns {string}
   */
  function vtt(data) {
    let i = 0;
    let len = 0;
    let lines;
    let time;
    let text;
    let sub;

    // Simple function to convert HH:MM:SS.MMM to seconds
    // Assume valid, returns 0 on error
    const toSeconds = function (t_in) {
      const t = t_in.split(':');
      try {
        let s = t[2].split('.');
        // Just in case a , is decimal separator
        if (s.length === 1) {
          s = t[2].split(',');
        }
        return (
          parseFloat(t[0], 10) * 3600 +
          parseFloat(t[1], 10) * 60 +
          parseFloat(s[0], 10) +
          parseFloat(s[1], 10) / 1000
        );
      } catch (e) {
        return 0;
      }
    };

    const captionWords = [];   // { ms, html, cueEnd, lastInCue }, in order

    // Split on line breaks
    lines = data.split(/(?:\r\n|\r|\n)/gm);
    len = lines.length;

    // Skip the WEBVTT header line
    let startLine = 0;
    if (lines[0].indexOf('WEBVTT') === 0) {
      startLine = 1;
      // Skip any header metadata lines
      while (startLine < len && lines[startLine].trim() !== '') {
        startLine++;
      }
      // Skip the blank line after the header
      startLine++;
    }

    for (i = startLine; i < len; i++) {
      sub = {};
      text = [];

      // Skip empty lines
      if (!lines[i].trim()) {
        continue;
      }

      // Check if the line is a cue identifier (optional in WebVTT)
      if (lines[i].indexOf('-->') === -1) {
        // This might be a cue identifier, skip to the next line
        i++;
        // Skip if we've reached the end
        if (i >= len) break;
      }

      // Parse the timestamp line
      if (lines[i].indexOf('-->') !== -1) {
        time = lines[i].split(/[\t ]*-->[\t ]*/);
        sub.start = toSeconds(time[0]);

        // Extract end time, removing any cue settings
        const endTimeStr = time[1].split(/[\t ]/)[0];
        sub.end = toSeconds(endTimeStr);

        // Move to the next line, which should be the start of the text
        i++;

        // Collect all lines of text until we hit an empty line
        while (i < len && lines[i].trim() !== '') {
          text.push(lines[i]);
          i++;
        }

        // Join the text lines, then the tags
        sub.text = cueText(text.join(' '));

        cueWords(sub.text, sub.start, sub.end, captionWords);
      }
    }

    return captionWordsToHtml(captionWords);
  }

  const api = { srt, vtt, captionWordsToHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.HyperaudioConverters = root.HyperaudioConverters || {};
    Object.assign(root.HyperaudioConverters, api);
  }
}(typeof window !== 'undefined' ? window : null));

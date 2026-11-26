/**
 * converters/captions.js
 * (C) The Hyperaudio Project
 * @version 1.3.55 — last changed in release 1.3.55
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
 * A WebVTT cue may time its own words with inline timestamps, as in
 * `one <00:00:02.000>two`, and the editor's word-level download writes them
 * with each word in a <c> tag (#842). Those words take their times from the
 * file, and the timestamps and <c> tags are not kept as text.
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

  // WebVTT's inline timestamps, hours optional, and its <c> class spans
  // (<c>, <c.name>, </c>), which the editor's word-level download puts
  // round each word (#842)
  const INLINE_TIME = /<((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})>/g;
  const CLASS_TAG = /<\/?c(?:\.[^\s>]*)?>/gi;
  const MARK = '\u0001';   // stands in for a timestamp while the text is escaped

  const inlineSeconds = (t) => {
    const parts = t.split(':').map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  };

  // A WebVTT file with its inline timestamps and <c> tags taken out, the
  // rest as it was: the captions an import keeps (#842). A file with no
  // inline timestamps comes back untouched, its <c.name> colours included
  function withoutInlineTimes(data) {
    const text = String(data);
    INLINE_TIME.lastIndex = 0;
    if (!INLINE_TIME.test(text)) return text;
    return text.replace(INLINE_TIME, '').replace(CLASS_TAG, '');
  }

  // One cue's text whose words are timed inline (#842). A timestamp starts
  // the first word after it, words before the first one start with the cue,
  // and words that share the stretch between two timestamps share its time.
  // A timestamp outside the cue is held to it, and one that would start a
  // word before the word ahead of it is ignored.
  function timedCueWords(raw, start, end, captionWords) {
    const times = [];
    const marked = raw.replace(CLASS_TAG, '').replace(INLINE_TIME, (m, t) => {
      times.push(inlineSeconds(t));
      return ' ' + MARK + (times.length - 1) + MARK + ' ';
    });
    // groups of words, each with the time its first word starts
    const groups = [{ at: start, words: [] }];
    cueText(marked).split(/\s+/).forEach((token) => {
      if (token === '') return;
      const time = new RegExp('^' + MARK + '(\\d+)' + MARK + '$').exec(token);
      if (time !== null) {
        const at = Math.min(Math.max(times[Number(time[1])], start), end);
        if (at >= groups[groups.length - 1].at) groups.push({ at, words: [] });
        return;
      }
      groups[groups.length - 1].words.push(token);
    });
    // a token that is only a tag, such as the <b> before a timed word,
    // joins the word after it, or the one before it at the cue's end
    const plain = (html) => html.replace(/<[^>]*>/g, '');
    let carried = '';
    groups.forEach((group) => {
      group.words = group.words.reduce((kept, word) => {
        if (plain(carried + word) === '') { carried += word; return kept; }
        kept.push(carried + word);
        carried = '';
        return kept;
      }, []);
    });
    const timed = [];
    groups.forEach((group, g) => {
      const until = g + 1 < groups.length ? groups[g + 1].at : end;
      const step = group.words.length > 0 ? (until - group.at) / group.words.length : 0;
      group.words.forEach((word, w) => timed.push({ ms: Math.round((group.at + w * step) * 1000), html: word }));
    });
    if (carried !== '' && timed.length > 0) timed[timed.length - 1].html += carried;
    timed.forEach((word, w) => {
      captionWords.push({ ms: word.ms, html: word.html, cueEnd: end, lastInCue: w === timed.length - 1 });
    });
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

    // Simple function to convert HH:MM:SS.MMM to seconds, the hours
    // optional as WebVTT allows (#861). Assume valid, returns 0 on error
    const toSeconds = function (t_in) {
      const t = t_in.trim().split(':');
      if (t.length === 2) t.unshift('0');
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

        // Words timed inline take the file's times (#842). Otherwise join
        // the text lines, then the tags, and share the cue's time out
        const joined = text.join(' ');
        INLINE_TIME.lastIndex = 0;
        if (INLINE_TIME.test(joined)) {
          timedCueWords(joined, sub.start, sub.end, captionWords);
        } else {
          sub.text = cueText(joined);
          cueWords(sub.text, sub.start, sub.end, captionWords);
        }
      }
    }

    return captionWordsToHtml(captionWords);
  }

  const api = { srt, vtt, captionWordsToHtml, withoutInlineTimes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.HyperaudioConverters = root.HyperaudioConverters || {};
    Object.assign(root.HyperaudioConverters, api);
  }
}(typeof window !== 'undefined' ? window : null));

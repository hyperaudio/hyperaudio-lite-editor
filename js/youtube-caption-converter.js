(function (root) {
  function decodeEntities(value) {
    return String(value)
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeLines(value) {
    return String(value || '').replace(/\r\n|\r/g, '\n');
  }

  function parseTimestampMs(value) {
    const clean = String(value || '').trim().replace(',', '.');
    if (!clean) return 0;

    if (!clean.includes(':')) {
      const numeric = Number(clean);
      return Number.isFinite(numeric) ? Math.round(numeric * 1000) : 0;
    }

    const parts = clean.split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return 0;

    let seconds = 0;
    if (parts.length === 3) {
      seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      seconds = parts[0] * 60 + parts[1];
    } else {
      seconds = parts[0];
    }
    return Math.round(seconds * 1000);
  }

  function parseXmlTimeMs(value, fallbackMs, decimalIsSeconds) {
    if (value === undefined || value === null || value === '') return fallbackMs;
    const clean = String(value).trim();
    if (clean.includes(':')) return parseTimestampMs(clean);

    const numeric = Number(clean);
    if (!Number.isFinite(numeric)) return fallbackMs;
    if (clean.includes('.') || decimalIsSeconds) return Math.round(numeric * 1000);
    return Math.round(numeric);
  }

  function formatTimestamp(ms) {
    const safeMs = Math.max(0, Math.round(ms));
    const hours = Math.floor(safeMs / 3600000);
    const minutes = Math.floor((safeMs % 3600000) / 60000);
    const seconds = Math.floor((safeMs % 60000) / 1000);
    const millis = safeMs % 1000;
    return [
      String(hours).padStart(2, '0'),
      String(minutes).padStart(2, '0'),
      `${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`,
    ].join(':');
  }

  function stripTags(value) {
    return String(value || '').replace(/<[^>]+>/g, ' ');
  }

  function splitWords(value) {
    const text = decodeEntities(stripTags(value)).replace(/\s+/g, ' ').trim();
    return text ? text.split(' ') : [];
  }

  function wordsForSegment(text, startMs, endMs) {
    const words = splitWords(text);
    if (words.length === 0) return [];

    const duration = Math.max(0, endMs - startMs);
    const step = words.length > 0 ? duration / words.length : 0;

    return words.map((word, index) => {
      const wordStart = Math.round(startMs + step * index);
      const wordEnd = index === words.length - 1
        ? Math.round(endMs)
        : Math.round(startMs + step * (index + 1));
      return {
        startMs: wordStart,
        endMs: Math.max(wordStart, wordEnd),
        text: word,
      };
    });
  }

  function wordsFromTimedCue(text, cueStartMs, cueEndMs) {
    const timestampPattern = /<((?:\d{1,2}:)?\d{2}:\d{2}[\.,]\d{3})>/g;
    const segments = [];
    let activeStart = cueStartMs;
    let lastIndex = 0;
    let match;

    while ((match = timestampPattern.exec(text)) !== null) {
      const segmentText = text.slice(lastIndex, match.index);
      if (segmentText.trim()) {
        segments.push({ startMs: activeStart, text: segmentText });
      }
      activeStart = parseTimestampMs(match[1]);
      lastIndex = match.index + match[0].length;
    }

    const finalText = text.slice(lastIndex);
    if (finalText.trim()) {
      segments.push({ startMs: activeStart, text: finalText });
    }

    if (segments.length === 0) {
      return wordsForSegment(text, cueStartMs, cueEndMs);
    }

    return segments.flatMap((segment, index) => {
      const segmentEnd = index < segments.length - 1 ? segments[index + 1].startMs : cueEndMs;
      return wordsForSegment(segment.text, segment.startMs, segmentEnd);
    });
  }

  function paragraphsToHtml(paragraphs) {
    const body = paragraphs.map((words) => {
      const spans = words.map((word) => {
        const start = Math.round(word.startMs);
        const duration = Math.max(0, Math.round(word.endMs - word.startMs));
        return `<span data-m="${start}" data-d="${duration}">${escapeHtml(word.text)} </span>`;
      }).join('');
      return `<p>${spans}</p>`;
    }).join('');

    return `<article><section>${body}</section></article>`;
  }

  function youtubeVttToHtml(data) {
    const blocks = normalizeLines(data)
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean);

    const paragraphs = [];
    for (const block of blocks) {
      const lines = block.split('\n').map((line) => line.trimEnd());
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex === -1) continue;

      const timing = lines[timingIndex].split(/[\t ]*-->[\t ]*/);
      const startMs = parseTimestampMs(timing[0]);
      const endMs = parseTimestampMs((timing[1] || '').split(/\s+/)[0]);
      const cueText = lines.slice(timingIndex + 1).join(' ');
      const words = wordsFromTimedCue(cueText, startMs, endMs);
      if (words.length > 0) paragraphs.push(words);
    }

    return paragraphsToHtml(paragraphs);
  }

  function parseAttributes(value) {
    const attrs = {};
    const attrPattern = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = attrPattern.exec(value || '')) !== null) {
      attrs[match[1]] = match[3] !== undefined ? match[3] : match[4];
    }
    return attrs;
  }

  function parseSrv3Paragraphs(xml) {
    const paragraphs = [];
    const pPattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let pMatch;

    while ((pMatch = pPattern.exec(xml)) !== null) {
      const pAttrs = parseAttributes(pMatch[1]);
      const pStart = parseXmlTimeMs(pAttrs.t || pAttrs.start, 0, Boolean(pAttrs.start));
      const pDuration = parseXmlTimeMs(pAttrs.d || pAttrs.dur, 0, Boolean(pAttrs.dur));
      const pEnd = pDuration > 0 ? pStart + pDuration : pStart;
      const sMatches = Array.from(pMatch[2].matchAll(/<s\b([^>]*)>([\s\S]*?)<\/s>/gi));

      if (sMatches.length === 0) {
        const words = wordsForSegment(pMatch[2], pStart, pEnd);
        if (words.length > 0) paragraphs.push(words);
        continue;
      }

      const words = [];
      for (let i = 0; i < sMatches.length; i++) {
        const sAttrs = parseAttributes(sMatches[i][1]);
        const sStart = pStart + parseXmlTimeMs(sAttrs.t, 0, false);
        const nextStart = i < sMatches.length - 1
          ? pStart + parseXmlTimeMs(parseAttributes(sMatches[i + 1][1]).t, pEnd - pStart, false)
          : pEnd;
        const sDuration = parseXmlTimeMs(sAttrs.d, Math.max(0, nextStart - sStart), false);
        words.push(...wordsForSegment(sMatches[i][2], sStart, sStart + sDuration));
      }
      if (words.length > 0) paragraphs.push(words);
    }

    return paragraphs;
  }

  function parseTranscriptText(xml) {
    const paragraphs = [];
    const textPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let match;

    while ((match = textPattern.exec(xml)) !== null) {
      const attrs = parseAttributes(match[1]);
      const startMs = parseXmlTimeMs(attrs.start, 0, true);
      const durationMs = parseXmlTimeMs(attrs.dur, 0, true);
      const words = wordsForSegment(match[2], startMs, startMs + durationMs);
      if (words.length > 0) paragraphs.push(words);
    }

    return paragraphs;
  }

  function youtubeTimedTextXmlToHtml(data) {
    const xml = normalizeLines(data);
    const paragraphs = parseSrv3Paragraphs(xml);
    if (paragraphs.length > 0) return paragraphsToHtml(paragraphs);
    return paragraphsToHtml(parseTranscriptText(xml));
  }

  function normalizeJsonWords(jsonData) {
    return ((jsonData && jsonData.words) || [])
      .filter((word) => word && word.text !== undefined)
      .map((word) => ({
        startMs: Math.round(Number(word.start) * 1000),
        endMs: Math.round(Number(word.end) * 1000),
        text: String(word.text),
      }))
      .filter((word) => Number.isFinite(word.startMs) && Number.isFinite(word.endMs));
  }

  function groupWordsByParagraph(jsonData) {
    const words = normalizeJsonWords(jsonData);
    const paragraphs = (jsonData && jsonData.paragraphs) || [];
    if (paragraphs.length === 0) return words.length > 0 ? [words] : [];

    return paragraphs.map((paragraph) => {
      const startMs = Math.round(Number(paragraph.start) * 1000);
      const endMs = Math.round(Number(paragraph.end) * 1000);
      return words.filter((word) => word.startMs >= startMs && word.startMs <= endMs);
    }).filter((group) => group.length > 0);
  }

  function hyperaudioJsonToYoutubeVtt(jsonData) {
    const cues = groupWordsByParagraph(jsonData).map((words) => {
      const start = words[0].startMs;
      const end = words[words.length - 1].endMs;
      const text = words
        .map((word) => `<${formatTimestamp(word.startMs)}>${escapeHtml(word.text)}`)
        .join(' ');
      return `${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${text}`;
    });

    return `WEBVTT\n\n${cues.join('\n\n')}\n`;
  }

  function hyperaudioJsonToYoutubeTimedTextXml(jsonData) {
    const paragraphs = groupWordsByParagraph(jsonData).map((words) => {
      const pStart = words[0].startMs;
      const pEnd = words[words.length - 1].endMs;
      const spans = words.map((word) => {
        const relativeStart = Math.max(0, word.startMs - pStart);
        const duration = Math.max(0, word.endMs - word.startMs);
        return `<s t="${relativeStart}" d="${duration}">${escapeHtml(word.text)}</s>`;
      }).join('');
      return `<p t="${pStart}" d="${Math.max(0, pEnd - pStart)}">${spans}</p>`;
    });

    return `<timedtext>\n<body>\n${paragraphs.join('\n')}\n</body>\n</timedtext>\n`;
  }

  const api = {
    hyperaudioJsonToYoutubeTimedTextXml,
    hyperaudioJsonToYoutubeVtt,
    youtubeTimedTextXmlToHtml,
    youtubeVttToHtml,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);

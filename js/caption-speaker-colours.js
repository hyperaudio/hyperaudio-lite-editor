/**
 * caption-speaker-colours.js
 * (C) The Hyperaudio Project
 * @version 1.3.21 — last changed in release 1.3.21
 * @license MIT
 *
 * Speaker-coloured caption downloads (#536), export only.
 *
 * With the Settings toggle on, the .vtt and .srt downloads carry a colour per
 * speaker. Nothing else changes: the live <track>, the saved captions, the
 * burn-in overlay and the interactive-transcript sidecar are untouched.
 *
 * Export only, because the caption editor is the source of truth for captions
 * and a caption row is four <input> values. generateCaptionsFromCaptionEditor
 * rebuilds the whole file from those values with a bare WEBVTT header, so a
 * STYLE block would be erased by the first caption edit and a <v Name> tag
 * inside a line would show up literally in the text box, count against the
 * reading-rate limit (#639, #641), and vanish when that line was retyped. A
 * downloaded file is a leaf — nothing reads it back — so the colour is added
 * at the moment of writing and the pipeline never learns about the markup.
 *
 * The speaker is NOT looked up here. It is recorded on each caption row as
 * data-speaker when the captions are generated from the transcript, and again
 * on Regenerate (editor-core.js, editor-main.js). Captions diverge from the
 * transcript the moment anyone edits them, so a lookup at download time would
 * let a later transcript edit silently recolour captions the user had already
 * finished. This module is handed the finished text and the list of speakers
 * in cue order, and does nothing but decorate.
 *
 * Browser support, measured (Chromium / WebKit / Firefox): both a STYLE block
 * with ::cue(v[voice="…"]) and a class selector colour in Chromium and WebKit;
 * Firefox ignores every mechanism and renders plain white. Chromium and WebKit
 * also hide the voice tag itself, so a player that understands <v> but not
 * STYLE degrades to uncoloured captions rather than showing markup.
 *
 * Loaded as a plain <script>; self-wires the #download-vtt and #download-srt
 * menu links the way word-vtt.js wires its own. Removing this file removes the
 * feature and leaves the plain downloads exactly as they were. Also exported
 * for unit tests.
 */

(function () {
  // Bright on the translucent black ground browsers paint behind captions, and
  // distinguishable from each other. Every one clears 9.7:1 against black and
  // the set averages 12.6:1, measured. Deliberately not red-then-green: the
  // commonest colour blindness would make that pair the hardest two speakers
  // to tell apart. The two blues sit at either end, so a conversation has to
  // reach eight speakers before they meet.
  const PALETTE = Object.freeze([
    '#5cd5ff',   // sky
    '#ffe45c',   // yellow
    '#9dff70',   // lime
    '#ffa06b',   // orange
    '#c9a3ff',   // violet
    '#5cead4',   // turquoise
    '#ff8ac2',   // pink
    '#8fb8ff',   // periwinkle
  ]);

  // Cue text is written raw by both VTT writers. Inside <v> markup that is
  // unsafe — "<inaudible>" would read as a malformed tag and swallow the word,
  // a bare "&" starts an entity — so it is escaped here, and only here: with
  // the toggle off the download is byte-for-byte what it always was. Same
  // convention as escapeVttText in word-vtt.js (#409).
  function escapeCueText(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // A speaker name is user-editable text, so it can hold anything. A newline
  // would end the voice tag's start line and a ">" would close it early.
  function sanitiseName(name) {
    if (typeof name !== 'string') return '';
    return escapeCueText(name.replace(/\s+/g, ' ').trim());
  }

  // Speakers in cue order to a name → colour map, assigned by first appearance
  // and cycling past the end of the palette, so the same conversation always
  // colours the same way however many speakers it has.
  function assignColours(speakers) {
    const colours = new Map();
    // an entry is a name, or [first, second] for a caption two speakers share
    (Array.isArray(speakers) ? speakers : []).flat().forEach((raw) => {
      const name = sanitiseName(raw);
      if (name === '' || colours.has(name)) return;
      colours.set(name, PALETTE[colours.size % PALETTE.length]);
    });
    return colours;
  }

  // Split caption text into blocks on blank lines, keeping each block's lines.
  // Both formats are blank-line separated, which is all the structure either
  // side of this needs.
  function splitBlocks(text) {
    return String(text).replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => b.replace(/\n+$/, ''));
  }

  // Blocks back to a document, ending the way the input ended: splitting drops
  // the trailing newline a caption file conventionally carries, and a download
  // should not differ from the plain one in invisible ways.
  function joinBlocks(blocks, original) {
    const tail = /\n*$/.exec(String(original).replace(/\r\n/g, '\n'))[0];
    return blocks.join('\n\n') + tail;
  }

  const isTimingLine = (line) => line.indexOf(' --> ') !== -1;

  // A cue block's payload: everything after its timing line. The identifier
  // line some files carry before the timing line is left where it is.
  function payloadOf(lines) {
    const at = lines.findIndex(isTimingLine);
    return at === -1 ? null : { at, head: lines.slice(0, at + 1), body: lines.slice(at + 1) };
  }

  // A caption two speakers share (#666): its entry is [first, second], its
  // two lines are one speaker's each, and each opens with a hyphen — the
  // Netflix form, which is how the generator and the plain files mark it. In
  // a coloured file the colour marks the speaker instead, as the BBC does it,
  // so each line is wrapped on its own and its hyphen dropped. Returns null
  // for any other cue — including one whose lines no longer number two,
  // because somebody retyped it — which is then coloured whole, as its first
  // speaker's.
  function dualLines(entry, body) {
    if (!Array.isArray(entry) || body.length !== 2) return null;
    const names = entry.map(sanitiseName);
    if (names.length !== 2 || names[0] === '' || names[1] === '') return null;
    return body.map((line, i) => ({ name: names[i], text: escapeCueText(line.replace(/^-\s?/, '').trim()) }));
  }
  const firstOf = (entry) => (Array.isArray(entry) ? entry[0] : entry);

  /**
   * Decorate a WebVTT document with a STYLE block and one voice tag per cue.
   * @param {string} vtt the finished VTT
   * @param {Array<string|string[]>} speakers one entry per cue, in cue order: a
   *   name, [first, second] for a caption two speakers share, '' or null for none
   * @returns {string} the decorated VTT, or the input unchanged when no cue has a speaker
   */
  function decorateVtt(vtt, speakers) {
    const colours = assignColours(speakers);
    if (colours.size === 0) return String(vtt);

    let cue = 0;
    const blocks = splitBlocks(vtt).map((block) => {
      const lines = block.split('\n');
      const parts = payloadOf(lines);
      if (parts === null) return block;   // header, STYLE, NOTE: left alone
      const entry = speakers[cue];
      cue += 1;
      const dual = dualLines(entry, parts.body);
      if (dual !== null) {
        return parts.head.concat(dual.map((line) => `<v ${line.name}>${line.text}</v>`)).join('\n');
      }
      const name = sanitiseName(firstOf(entry));
      if (name === '' || parts.body.length === 0) {
        return block;
      }
      const body = parts.body.map(escapeCueText).join('\n');
      return parts.head.concat(`<v ${name}>${body}</v>`).join('\n');
    });

    // The STYLE block goes after the header and before the first cue, which is
    // where the spec requires it.
    const style = ['STYLE'].concat(
      [...colours.entries()].map(([name, colour]) => `::cue(v[voice="${name}"]) { color: ${colour}; }`)
    ).join('\n');
    const first = blocks.findIndex((b) => b.split('\n').some(isTimingLine));
    const at = first === -1 ? blocks.length : first;
    return joinBlocks(blocks.slice(0, at).concat(style, blocks.slice(at)), vtt);
  }

  /**
   * Decorate an SRT document with a font colour per cue. Player-dependent:
   * VLC and most desktop players honour it, no standard requires it.
   * @param {string} srt the finished SRT
   * @param {string[]} speakers one entry per cue, in cue order
   * @returns {string} the decorated SRT, or the input unchanged when no cue has a speaker
   */
  function decorateSrt(srt, speakers) {
    const colours = assignColours(speakers);
    if (colours.size === 0) return String(srt);

    let cue = 0;
    const blocks = splitBlocks(srt).map((block) => {
      const lines = block.split('\n');
      const parts = payloadOf(lines);
      if (parts === null) return block;
      const entry = speakers[cue];
      cue += 1;
      const dual = dualLines(entry, parts.body);
      if (dual !== null) {
        return parts.head.concat(dual.map((line) =>
          `<font color="${colours.get(line.name)}">${line.text}</font>`)).join('\n');
      }
      const name = sanitiseName(firstOf(entry));
      const colour = colours.get(name);
      if (colour === undefined || parts.body.length === 0) return block;
      const body = parts.body.map(escapeCueText).join('\n');
      return parts.head.concat(`<font color="${colour}">${body}</font>`).join('\n');
    });
    return joinBlocks(blocks, srt);
  }

  // ---- browser wiring ------------------------------------------------------

  const enabled = () => {
    const s = window.HyperaudioSettings;
    return !!(s && typeof s.get === 'function' && s.get('captionColourSpeakers') === true);
  };

  // Every cue's start time, in the order the cues appear.
  function cueStarts(text) {
    return splitBlocks(text)
      .map((block) => block.split('\n').find(isTimingLine))
      .filter((line) => line !== undefined)
      .map((line) => line.slice(0, line.indexOf(' --> ')).trim());
  }

  // What the captions recorded when they were generated. Empty means the
  // caption editor has never been built — a download straight from a freshly
  // opened page — in which case no caption has been edited and the transcript
  // is still the whole truth, so it is read for this one export rather than
  // handing back a plain file. Every other time the recorded list wins.
  const speakerList = (plain) => {
    const recorded = typeof window.captionSpeakerList === 'function' ? window.captionSpeakerList() : [];
    if (recorded.length > 0) return recorded;
    if (typeof window.captionSpeakersForCues !== 'function') return [];
    return window.captionSpeakersForCues(cueStarts(plain));
  };

  // The existing link already carries a current data: URL of the plain file,
  // written by whichever caption writer ran last. Reading it back is what keeps
  // this module out of the two writers: it decorates a finished document and
  // knows nothing about how the document was produced.
  function textFromLink(link) {
    const href = link.getAttribute('href') || '';
    const comma = href.indexOf(',');
    if (!href.startsWith('data:') || comma === -1) return null;
    try {
      return decodeURIComponent(href.slice(comma + 1));
    } catch (e) {
      return null;
    }
  }

  // Drive the download from a throwaway anchor rather than mutating this link's
  // href mid-click, which is more reliable across browsers (as word-vtt.js does).
  function wireDownloadLink(id, decorate, type, fallbackName) {
    const link = document.getElementById(id);
    if (link === null || link.dataset.speakerColours === '1') return;
    link.dataset.speakerColours = '1';
    link.addEventListener('click', (event) => {
      if (!enabled()) return;                 // plain download, untouched
      const plain = textFromLink(link);
      if (plain === null) return;
      const speakers = speakerList(plain);
      if (speakers.length === 0) return;      // no speakers recorded: nothing to colour
      const decorated = decorate(plain, speakers);
      if (decorated === plain) return;
      event.preventDefault();
      const blob = new Blob([decorated], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = link.getAttribute('download') || fallbackName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    });
  }

  function wire() {
    wireDownloadLink('download-vtt', decorateVtt, 'text/vtt', 'hyperaudio.vtt');
    wireDownloadLink('download-srt', decorateSrt, 'text/plain', 'hyperaudio.srt');
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', wire);
    } else {
      wire();
    }
    window.CaptionSpeakerColours = Object.freeze({
      PALETTE, decorateVtt, decorateSrt, assignColours, escapeCueText, sanitiseName, cueStarts,
    });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PALETTE, decorateVtt, decorateSrt, assignColours, escapeCueText, sanitiseName, cueStarts };
  }
})();

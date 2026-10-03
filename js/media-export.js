/**
 * media-export.js
 * (C) The Hyperaudio Project
 * @version 1.3.32 — last changed in release 1.3.32
 * @license MIT
 *
 * Media export via mediabunny (#289, #291, #292): export the loaded media as
 * WAV / M4A (AAC) / Ogg (Opus) / MP3, or — when the source has video — MP4 /
 * WebM, either:
 *
 *  - "Entire media": a straight conversion of the whole file (mediabunny's
 *    Conversion API — transmuxes when possible, transcodes when needed), or
 *  - "Edited media": with strikeouts and skipped silences removed. The kept
 *    sections come from the same computePlayableSections model that playback
 *    skipping uses (exposed as window.getPlayableSections). Audio is decoded
 *    per section (AudioBufferSink), trimmed sample-accurately at the edges,
 *    and appended (AudioBufferSource timestamps run from 0, so concatenation
 *    is implicit). Video frames are decoded per section (VideoSampleSink) and
 *    re-timestamped onto the edited timeline before encoding.
 *
 * An edited export can also download the transcript re-timed to the edited
 * media: struck words are dropped and each word's data-m is mapped through the
 * kept sections' cumulative offsets, so the transcript stays in sync with the
 * exported file.
 *
 * A video export can optionally BURN word-level captions into the frames (#387):
 * the same re-timed word data is grouped into short karaoke chunks (word-vtt.js)
 * and drawn onto each frame's canvas — a read-along highlight (spoken words full
 * white, upcoming words dimmed) — before the frame is encoded.
 *
 * mediabunny (and the MP3 encoder extension) are vendored under js/vendor/
 * (#381, so export works offline) and load lazily on first use —
 * non-exporting users pay nothing. Formats the browser can't encode are
 * omitted from the format list at modal-open time.
 */

(function () {
  // Bare specifiers, resolved to the vendored files in js/vendor/ by the
  // import map in index.html (#381). The map is what guarantees the
  // mp3-encoder extension's internal bare `import "mediabunny"` resolves to
  // the SAME module instance we encode with — registerMp3Encoder() registers
  // into our copy. Versions stay EXACT lockstep (mediabunny and the extension
  // release together); bump both vendored files and the import map as a pair.
  const MEDIABUNNY_SRC = 'mediabunny';
  const MP3_ENCODER_SRC = '@mediabunny/mp3-encoder';
  // SoundTouch (WSOLA) for pitch-preserved time-stretch when exporting at the
  // playback speed. LGPL-2.1, vendored unmodified.
  const SOUNDTOUCH_SRC = 'soundtouchjs';

  let mediabunnyPromise = null;
  let soundtouchPromise = null;
  let mp3Registered = false;

  const loadMediabunny = () => {
    if (mediabunnyPromise === null) {
      mediabunnyPromise = import(MEDIABUNNY_SRC);
    }
    return mediabunnyPromise;
  };

  const loadSoundtouch = () => {
    if (soundtouchPromise === null) {
      soundtouchPromise = import(SOUNDTOUCH_SRC);
    }
    return soundtouchPromise;
  };

  // MP3 encoding is not built into browsers; mediabunny's official extension
  // polyfills an encoder. Returns true when MP3 encoding is available.
  const ensureMp3Encoder = async (mb) => {
    if (mp3Registered) return true;
    try {
      const ext = await import(MP3_ENCODER_SRC);
      ext.registerMp3Encoder();
      mp3Registered = true;
      return true;
    } catch (e) {
      console.warn('MP3 encoder unavailable:', e);
      return false;
    }
  };

  const FORMATS = [
    { id: 'wav',  label: 'WAV (uncompressed audio)', ext: 'wav',  mime: 'audio/wav',  kind: 'audio', codec: 'pcm-s16', make: (mb) => new mb.WavOutputFormat() },
    { id: 'm4a',  label: 'M4A (AAC audio)',          ext: 'm4a',  mime: 'audio/mp4',  kind: 'audio', codec: 'aac',     make: (mb) => new mb.Mp4OutputFormat() },
    { id: 'ogg',  label: 'Ogg (Opus audio)',         ext: 'ogg',  mime: 'audio/ogg',  kind: 'audio', codec: 'opus',    make: (mb) => new mb.OggOutputFormat() },
    { id: 'mp3',  label: 'MP3 (audio)',              ext: 'mp3',  mime: 'audio/mpeg', kind: 'audio', codec: 'mp3',     make: (mb) => new mb.Mp3OutputFormat(), needsMp3: true },
    { id: 'mp4',  label: 'MP4 (H.264 video + AAC)',  ext: 'mp4',  mime: 'video/mp4',  kind: 'video', vcodec: 'avc',  acodec: 'aac',  make: (mb) => new mb.Mp4OutputFormat() },
    { id: 'webm', label: 'WebM (VP9 video + Opus)',  ext: 'webm', mime: 'video/webm', kind: 'video', vcodec: 'vp9', acodec: 'opus', make: (mb) => new mb.WebMOutputFormat() },
  ];

  const canEncodeAudio = async (mb, codec) => {
    if (codec === 'pcm-s16') return true; // PCM needs no encoder
    try { return mb.canEncodeAudio ? await mb.canEncodeAudio(codec) : true; }
    catch (e) { return false; }
  };
  const canEncodeVideo = async (mb, codec) => {
    try { return mb.canEncodeVideo ? await mb.canEncodeVideo(codec) : true; }
    catch (e) { return false; }
  };

  // ---------------------------------------------------------------------------
  // Source media
  // ---------------------------------------------------------------------------

  const playerSrc = () => {
    const player = document.getElementById('hyperplayer');
    return player !== null ? player.src : '';
  };

  // Read the media BYTES, for the project the run captured (#656). The
  // player's src is the obvious source but not a reliable one: an object URL
  // made from an OPFS file is a snapshot, and once that file is rewritten
  // (any save that re-writes media does) the URL still plays from buffered
  // data yet fails to read back — "Failed to fetch" on some projects and not
  // others. So the library's stored file wins when it exists — the file of
  // the project NAMED in the context, not whichever is current by the time
  // this runs — then the File the session held at the click, then the src
  // the player had then (URL-mode media, or no project at all). Nothing here
  // reads the live page: a project opened during the run cannot lend its
  // media. Both failing is a real error, reported for what it is.
  const readMediaBlob = async (ctx) => {
    const save = window.HyperaudioSave;
    if (ctx.projectId !== null && save && typeof save.mediaFileFor === 'function') {
      try {
        const file = await save.mediaFileFor(ctx.projectId);
        if (file && file.size > 0) return file;
      } catch (e) { /* fall through */ }
    }
    if (ctx.mediaFile !== null && ctx.mediaFile.size > 0) return ctx.mediaFile;
    const src = ctx.mediaSrc;
    if (!src) throw new Error('No media is loaded.');
    let response;
    try {
      response = await fetch(src);
      if (!response.ok) throw new Error(`Could not read the media (HTTP ${response.status}).`);
      return await response.blob();   // .blob() can fail too: a stale object URL dies here
    } catch (e) {
      if (src.startsWith('blob:')) {
        throw new Error('The media could not be re-read from this page. Reopen the project (or reload the media file) and try the export again.');
      }
      // playing cross-origin media needs no CORS, but READING its bytes does
      throw new Error('This media source does not allow cross-origin reading (CORS), so it cannot be exported. Load the file locally and try again.');
    }
  };

  const makeInput = async (mb, ctx) => {
    const blob = await readMediaBlob(ctx);
    return new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(blob) });
  };

  const sourceHasVideo = () => {
    const player = document.getElementById('hyperplayer');
    return player !== null && player.videoWidth > 0;
  };

  // ---------------------------------------------------------------------------
  // The export context (#656)
  // ---------------------------------------------------------------------------

  // One immutable picture of what is being exported, taken when the run
  // starts. A run used to read the LIVE editor at every step — the cuts and
  // the name before the render, then the transcript, the cues, the title and
  // the project metadata after it — so an edit made while the encoder ran,
  // or another project opened from Recents meanwhile, put that text, those
  // captions and that metadata beside the first project's media. Everything
  // a run needs is captured here, detached from the document, and every
  // output is derived from it; the live editor is not consulted again.
  //
  // sections/rate/dropStruck are the retiming inputs every helper below
  // takes; withProject adds the project metadata the flattened container
  // needs, which costs a transcript parse and is only read when asked for.
  const captureContext = ({ sections, rate, dropStruck, withProject, clip, frame }) => {
    const save = window.HyperaudioSave;
    const root = typeof window.currentTranscriptRoot === 'function'
      ? window.currentTranscriptRoot() : document.getElementById('hypertranscript');
    return {
      sections: sections.map((s) => ({ start: s.start, end: s.end })),
      rate,
      dropStruck: dropStruck === true,
      // a clip's selected words, by their own times (unpadded): { from, to }
      // the first word's start and the last word's end; null for no clip
      clip: clip ? { from: clip.from, to: clip.to } : null,
      // portrait/square framing for video (#690): { aspect, fit, position }
      frame: frame ? { aspect: frame.aspect, fit: frame.fit, position: frame.position } : null,
      transcript: root !== null && root !== undefined ? root.cloneNode(true) : null,
      captionsVtt: save && typeof save.getCaptionsVtt === 'function' ? save.getCaptionsVtt() : '',
      lineLengths: typeof window.captionLineLengths === 'function'
        ? window.captionLineLengths() : { max: 32, min: 21 },
      captionOptions: typeof window.captionOptions === 'function' ? window.captionOptions() : undefined,
      title: exportTitle(),
      projectId: save && save.library && typeof save.library.currentId === 'function'
        ? save.library.currentId() : null,
      mediaFile: save && typeof save.sessionMediaFile === 'function' ? save.sessionMediaFile() : null,
      mediaSrc: playerSrc(),
      project: withProject === true && save && typeof save.captureState === 'function'
        ? save.captureState() : null,
      // what a provenance file would say (#668), when that feature is loaded
      tpme: window.HyperaudioTpme && typeof window.HyperaudioTpme.capture === 'function'
        ? window.HyperaudioTpme.capture() : null,
    };
  };

  // ---------------------------------------------------------------------------
  // Sections / re-timing
  // ---------------------------------------------------------------------------

  // Kept sections from the editor (strikeouts + gap-skips applied), with any
  // Infinity end clamped to the real duration.
  const editedSections = (duration) => {
    const raw = typeof window.getPlayableSections === 'function' ? window.getPlayableSections() : null;
    if (!raw) return null;
    return raw
      .map((s) => ({ start: Math.max(0, s.start), end: Math.min(s.end, duration) }))
      .filter((s) => s.end > s.start + 0.001);
  };

  const keptDuration = (sections) => sections.reduce((sum, s) => sum + (s.end - s.start), 0);

  // A clip (#689): the kept sections — strikeouts and skipped silences
  // already out — limited to the selected stretch of media.
  const clipSections = (duration, clip) => {
    const base = editedSections(duration) || [{ start: 0, end: duration }];
    return base
      .map((s) => ({ start: Math.max(s.start, clip.start), end: Math.min(s.end, clip.end) }))
      .filter((s) => s.end > s.start + 0.001);
  };
  const inSections = (t, sections) => sections.some((s) => t >= s.start - 0.001 && t < s.end);

  const hasEdits = (sections, duration) =>
    sections !== null &&
    (sections.length > 1 || keptDuration(sections) < duration - 0.05);

  // Map an original-media time to the edited timeline.
  const mapTime = (t, sections) => {
    let offset = 0;
    for (const s of sections) {
      if (t < s.start) return offset;
      if (t <= s.end) return offset + (t - s.start);
      offset += s.end - s.start;
    }
    return offset;
  };

  // Clone the transcript with every word's data-m mapped onto the exported
  // timeline (and scaled when the playback speed is applied — data-d shrinks
  // with the sped-up media too). Returns the HTML.
  //
  // dropStruck follows the Entire/Edited choice (#605). The text has to match
  // the media it ships with: with Edited media the cuts are real, the struck
  // speech is gone from the audio, and the words must go with it. With Entire
  // media the original file is exported untouched — every struck word is still
  // audible — so removing them would describe audio that is not what plays.
  // Retiming needs no such flag: Entire media passes whole-timeline sections,
  // which makes mapTime an identity of its own accord.
  const buildRetimedTranscriptHtml = (ctx) => {
    if (ctx.transcript === null) return null;
    const { sections, rate, dropStruck } = ctx;
    const clone = ctx.transcript.cloneNode(true);
    clone.querySelectorAll('mark.search-mark').forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
    clone.querySelectorAll('[data-m]').forEach((span) => {
      if (dropStruck && (span.style.textDecoration || '').includes('line-through')) {
        span.remove();
        return;
      }
      const t = parseInt(span.getAttribute('data-m'), 10) / 1000;
      // a clip carries only its selected words (#689): outside the sections,
      // mapTime would stack them at the clip's first or last instant, and a
      // word starting in the padding after the selection was not selected.
      // A speaker label stays while its paragraph has words in the clip.
      if (ctx.clip !== null && !span.classList.contains('speaker')
          && (t < ctx.clip.from - 0.001 || t >= ctx.clip.to || !inSections(t, sections))) {
        span.remove();
        return;
      }
      span.setAttribute('data-m', String(Math.round((mapTime(t, sections) / rate) * 1000)));
      if (rate !== 1) {
        const d = parseInt(span.getAttribute('data-d'), 10);
        if (!isNaN(d)) span.setAttribute('data-d', String(Math.round(d / rate)));
      }
    });
    clone.querySelectorAll('p').forEach((p) => {
      if (p.querySelector('[data-m]:not(.speaker)') === null) p.remove();
    });
    clone.normalize();
    // canonical formatting (one span per line, data-m before data-d) so the
    // retimed transcript exports as clean as the plain HTML export
    return typeof window.serializeTranscriptHtml === 'function'
      ? window.serializeTranscriptHtml(clone)
      : clone.innerHTML;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---- The caption track is the source of truth for captions (#634) --------
   * Exports used to REGENERATE captions from the transcript and, for burn-in,
   * re-chunk it again by different rules — so a user's curated cues reached
   * neither the files nor the picture, and the two outputs disagreed with
   * each other. Both now come from the caption track.
   *
   * Cue TEXT is never rewritten. Only the times move, onto the edited
   * timeline. If a strike came after the captions were edited, the cue keeps
   * its words until the user regenerates: that is what the Regenerate button
   * is for, and #633 is where a strike reaches generation.
   * ---------------------------------------------------------------------- */

  const cueTime = (text) => {
    const m = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/.exec(text)
      || /(\d{2}):(\d{2})[.,](\d{1,3})/.exec(text);
    if (m === null) return null;
    return m.length === 5
      ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
      : Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
  };

  // WebVTT -> [{ start, end, lines }]. Cue settings after the arrow, and any
  // identifier line before it, are ignored: nothing downstream reads them.
  const parseVttCues = (vtt) => {
    const cues = [];
    String(vtt || '').split(/\r?\n/).forEach((line) => {
      const arrow = line.indexOf('-->');
      if (arrow !== -1) {
        const start = cueTime(line.slice(0, arrow));
        const end = cueTime(line.slice(arrow + 3));
        if (start !== null && end !== null) cues.push({ start, end, lines: [] });
        return;
      }
      const cue = cues[cues.length - 1];
      if (cue === undefined) return;               // WEBVTT header, NOTEs, blanks
      if (line.trim() === '') return;              // blank line: end of this cue's text
      cue.lines.push(line.trim());
    });
    return cues.filter((c) => c.lines.length > 0);
  };

  const pad = (n, width) => String(Math.floor(n)).padStart(width, '0');
  // Round the whole timestamp to integer milliseconds FIRST, then derive the
  // clock fields from that integer (#657). Flooring hours, minutes and seconds
  // separately and rounding the fraction on its own let a fraction that
  // rounds up to a whole second land in the millisecond field: 1.9995 s
  // became 00:00:01.1000, a four-digit field no player reads as a time.
  const clockOf = (seconds) => {
    const total = Math.round(Math.max(0, seconds) * 1000);
    return { h: Math.floor(total / 3600000), m: Math.floor((total % 3600000) / 60000), sec: Math.floor((total % 60000) / 1000), ms: total % 1000 };
  };
  const vttTime = (s) => { const c = clockOf(s); return `${pad(c.h, 2)}:${pad(c.m, 2)}:${pad(c.sec, 2)}.${pad(c.ms, 3)}`; };
  const srtTime = (s) => { const c = clockOf(s); return `${pad(c.h, 2)}:${pad(c.m, 2)}:${pad(c.sec, 2)},${pad(c.ms, 3)}`; };

  const cuesToVtt = (cues) => 'WEBVTT\n'
    + cues.map((c) => `\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.lines.join('\n')}\n`).join('');
  const cuesToSrt = (cues) => cues
    .map((c, i) => `\n${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.lines.join('\n')}\n`).join('');

  // Cues onto the exported timeline. Times only — a cue whose words were cut
  // away collapses to nothing and is dropped, but a cue that survives keeps
  // every word it had.
  const retimeCues = (cues, sections, rate) => cues
    .map((c) => ({
      start: mapTime(c.start, sections) / rate,
      end: mapTime(c.end, sections) / rate,
      lines: c.lines.slice(),
    }))
    .filter((c) => c.end - c.start > 0.05);

  // The caption track as the export should carry it, or null when the project
  // has no captions at all (nothing was ever generated).
  // null: the project has no caption track at all. []: it has one, and no cue
  // of it survives the cuts (#658). The two used to collapse into null, so a
  // curated track cut away entirely fell through to REGENERATING captions
  // from the transcript — the very thing #634 stopped exports doing once a
  // track exists. A present, emptied track stays empty.
  const retimedCues = (ctx) => {
    let cues = parseVttCues(ctx.captionsVtt);
    if (cues.length === 0) return null;   // no track, or one with no cues to begin with
    // a clip keeps the cues that overlap its selected words, not ones that
    // only reach into the padding either side (#689)
    if (ctx.clip !== null) cues = cues.filter((c) => c.end > ctx.clip.from + 0.001 && c.start < ctx.clip.to - 0.001);
    return retimeCues(cues, ctx.sections, ctx.rate);
  };

  // Re-timed WebVTT + SRT captions for the exported (edited) media. Generated
  // off a DETACHED copy of the re-timed transcript via the shared caption.js, so
  // struck words are dropped and times map onto the edited timeline. Passing a
  // non-existent playerId makes caption()'s player-side effects (setting the live
  // track src, forcing captions to show) a no-op — the live editor is untouched.
  // Returns { vtt, srt } or null.
  const genRetimedCaptions = (ctx) => {
    // the caption track first (#634); the generator below is the fallback for
    // a project whose captions were never generated at all
    const cues = retimedCues(ctx);
    // a track whose every cue was cut ships as a header-only track, and no
    // SRT (an empty SRT is not a file anyone wants): the sidecar says
    // honestly that nothing survived, rather than inventing cues (#658)
    if (cues !== null) return { vtt: cuesToVtt(cues), srt: cuesToSrt(cues) };
    if (typeof caption !== 'function') return null;
    const inner = buildRetimedTranscriptHtml(ctx);
    if (inner === null) return null;
    const host = document.createElement('div');
    const t = document.createElement('div');
    t.id = 'hypertranscript';
    t.innerHTML = inner;
    host.appendChild(t);
    try {
      const lines = ctx.lineLengths;
      return caption().init('hypertranscript', 'media-export-no-player',
        String(lines.max), String(lines.min), null, null, host, ctx.captionOptions);
    } catch (e) {
      console.warn('Caption generation for export failed:', e);
      return null;
    }
  };

  // A standalone interactive transcript page (hyperaudio-lite from CDN) that
  // links the exported media by its relative filename; the transcript is the
  // re-timed, struck-words-removed clone. trackSrc: a captions URL to link/embed,
  // or null to omit the <track> entirely (e.g. when captions are burned in).
  const buildInteractiveExportHtml = (ctx, mediaSrc, trackSrc) => {
    if (typeof hyperaudioTemplate !== 'string' || hyperaudioTemplate === '') return null;
    const inner = buildRetimedTranscriptHtml(ctx);
    if (inner === null) return null;
    let html = hyperaudioTemplate
      .replace('{hypertranscript}', () => inner)
      .replace('{sourcemedia}', () => mediaSrc)
      .replace('{sourcevtt}', () => (trackSrc || ''));
    if (!trackSrc) html = html.replace(/<track[^>]*>/i, '');
    return fillExportIdentity(html, inner, ctx.title);
  };

  // Word chunks for burn-in, already mapped onto the EDITED/output timeline.
  // buildRetimedTranscriptHtml drops struck words and maps each data-m through
  // the kept sections (÷ rate), so feeding its output to the shared chunker
  // (word-vtt.js) yields chunks whose times line up with the `t` the video loop
  // stamps on each frame — no separate mapping needed here. Returns null when
  // there is no transcript, no words, or word-vtt.js isn't loaded.
  // Contiguous vowel groups, the same estimate the editor's word-split uses;
  // the editor's own copy is preferred when it is loaded, so the two cannot
  // disagree about how a span's time divides.
  const syllablesIn = (token) => (typeof window.estimateSyllables === 'function'
    ? window.estimateSyllables(token)
    : Math.max(1, (String(token).toLowerCase().match(/[aeiouyàáâäãèéêëìíîïòóôöõùúûüýÿ]+/g) || []).length));

  // The words of the re-timed transcript, for lighting a cue word by word.
  const retimedWords = (ctx) => {
    const html = buildRetimedTranscriptHtml(ctx);
    if (html === null) return [];
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return [...tmp.querySelectorAll('[data-m]')]
      .filter((s) => !s.classList.contains('speaker'))
      .map((s) => ({ text: s.textContent.trim(), start: parseInt(s.getAttribute('data-m'), 10) / 1000 }))
      .filter((w) => w.text !== '');
  };

  // Burn-in chunks from the CUES (#634): their text, their line breaks, their
  // in and out times. Only the read-along highlight needs word timings, and
  // those come from the transcript where its words line up with the cue's —
  // the normal case, since the cue was generated from them. Where they do not
  // line up, because the cue was edited, the cue's own words share its span by
  // syllable weight, so the highlight still tracks rather than freezing.
  const cuesToChunks = (cues, words) => cues.map((cue) => {
    const lines = cue.lines.map((line) => line.split(/\s+/).filter((t) => t !== ''));
    const flat = [];
    lines.forEach((line) => line.forEach((text) => flat.push({ text })));
    if (flat.length === 0) return null;

    const inCue = words.filter((w) => w.start >= cue.start - 0.001 && w.start < cue.end);
    if (inCue.length === flat.length) {
      flat.forEach((word, i) => { word.start = inCue[i].start; });
    } else {
      const weights = flat.map((word) => syllablesIn(word.text));
      const total = weights.reduce((a, b) => a + b, 0);
      let cursor = cue.start;
      flat.forEach((word, i) => {
        word.start = cursor;
        cursor += (cue.end - cue.start) * (weights[i] / total);
      });
    }

    let at = 0;
    return {
      start: cue.start,
      end: cue.end,
      lines: lines.map((line) => line.map(() => flat[at++])),
    };
  }).filter((c) => c !== null);

  const buildCaptionChunks = (ctx) => {
    const cues = retimedCues(ctx);
    // a present track burns exactly its cues — none, when none survive the
    // cuts (#658) — and never falls through to the chunker below
    if (cues !== null) return cuesToChunks(cues, retimedWords(ctx));
    // no captions in the project: the karaoke chunker still gives the picture
    // something to say, as it did before there was a caption track to follow
    if (typeof window.hyperaudioWordChunks !== 'function') return null;
    const html = buildRetimedTranscriptHtml(ctx);
    if (html === null) return null;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const chunks = window.hyperaudioWordChunks({ source: tmp });
    return chunks.length ? chunks : null;
  };

  // Read-along caption colours, matching the editor transcript's states: the
  // word currently being spoken is accented (cf. .highlight.active), words
  // already spoken are full white (.read), upcoming words dimmed (.unread).
  const CAPTION_READ = 'rgba(255,255,255,1)';
  const CAPTION_ACTIVE = '#ffe14d';
  const CAPTION_UNREAD = 'rgba(255,255,255,0.45)';

  // Paint the active caption onto the frame for output-timeline time `t`.
  //
  // A cue is drawn as the caption editor has it — its words, its line breaks,
  // its in and out times (#634) — so the picture and the sidecar .vtt say the
  // same thing. A line still too wide for the safe area is wrapped, since a
  // cue written for a player's width cannot know the frame's. The karaoke
  // fallback (a project with no captions) arrives as a plain array of words
  // and is wrapped as it always was, held until the next chunk starts.
  //
  // Legibility comes from a soft shadow + a THIN outline: a thick stroke eats
  // the fill on slender glyph strokes and bleeds into letter counters (the holes
  // in o/e/a/d), so it is kept small and the fill is drawn shadow-free on top.
  // Where burned-in captions go (#690): one layout for every aspect. Type is
  // sized from the frame's shorter side, so landscape is as it always was and
  // a portrait frame gets the same size rather than one scaled to its height;
  // a caption line of the usual length then fits the column in any frame.
  // The one difference: in a tall frame the lines sit higher, clear of the
  // text TikTok, Instagram Reels and Shorts draw over the bottom of the video.
  const captionLayout = (w, h) => ({
    fontSize: Math.max(16, Math.round(Math.min(w, h) * 0.055)),
    maxWidth: w * 0.86,
    bottomMargin: h * (h > w * 1.25 ? 0.18 : 0.10),
    centreX: w / 2,
  });

  const drawCaptionOverlay = (ctx, t, chunks, w, h) => {
    const startOf = (c) => (Array.isArray(c) ? c[0].start : c.start);
    let active = null;
    for (const c of chunks) {
      if (startOf(c) <= t) active = c; else break;
    }
    if (active === null) return;
    // a cue ends when it says it ends; the fallback has no end and is held
    if (!Array.isArray(active) && t >= active.end) return;

    const sourceLines = Array.isArray(active) ? [active] : active.lines;
    const words = Array.isArray(active) ? active : active.lines.flat();

    // Exactly one active word: the last whose start has been reached. Earlier
    // words are "read", later ones "unread".
    let activeWord = null;
    for (const word of words) {
      if (word.start <= t) activeWord = word; else break;
    }
    const seen = new Set();
    for (const word of words) {
      if (word === activeWord) break;
      seen.add(word);
    }

    const layout = captionLayout(w, h);
    const font = (px) => `700 ${px}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';

    // The caption's own lines, exactly as made in the editor (#690): never
    // re-broken. When the widest line is too wide for the column, the type
    // shrinks until it fits, rather than a line wrapping into two.
    const lineWidth = (line) => line.reduce((sum, word, i) =>
      sum + (i ? ctx.measureText(' ').width : 0) + ctx.measureText(word.text).width, 0);
    ctx.font = font(layout.fontSize);
    const widest = Math.max(...sourceLines.map(lineWidth));
    const fontSize = widest > layout.maxWidth
      ? Math.max(12, Math.floor(layout.fontSize * layout.maxWidth / widest))
      : layout.fontSize;
    ctx.font = font(fontSize);
    const spaceW = ctx.measureText(' ').width;
    const lines = sourceLines.filter((line) => line.length > 0);

    const lineH = fontSize * 1.25;
    let y = h - layout.bottomMargin - (lines.length - 1) * lineH;
    const strokeW = Math.max(2, fontSize * 0.06);
    for (const ln of lines) {
      let total = 0;
      ln.forEach((e, i) => { total += (i ? spaceW : 0) + ctx.measureText(e.text).width; });
      let x = layout.centreX - total / 2;                 // centre each line
      for (let i = 0; i < ln.length; i++) {
        if (i) x += spaceW;
        const word = ln[i];
        const text = word.text;
        // shadow halo + thin outline for legibility over any footage
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = fontSize * 0.16;
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.strokeText(text, x, y);
        // crisp fill with the shadow disabled so interiors stay clean
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.fillStyle = word === activeWord ? CAPTION_ACTIVE
          : (seen.has(word) ? CAPTION_READ : CAPTION_UNREAD);
        ctx.fillText(text, x, y);
        x += ctx.measureText(text).width;
      }
      y += lineH;
    }
    ctx.restore();
  };

  // ---------------------------------------------------------------------------
  // Export pipelines
  // ---------------------------------------------------------------------------

  const audioBitrate = (mb) => (mb.QUALITY_MEDIUM !== undefined ? mb.QUALITY_MEDIUM : 128e3);
  const videoBitrate = (mb) => (mb.QUALITY_MEDIUM !== undefined ? mb.QUALITY_MEDIUM : 2.5e6);

  // Entire media: one straight conversion.
  const exportEntire = async (mb, fmt, ctx, onProgress) => {
    const input = await makeInput(mb, ctx);
    const output = new mb.Output({ format: fmt.make(mb), target: new mb.BufferTarget() });
    const options = { input, output };
    if (fmt.kind === 'audio') options.video = { discard: true };
    const conversion = await mb.Conversion.init(options);
    conversion.onProgress = (p) => onProgress(p);
    try {
      await conversion.execute();
    } catch (err) {
      // release the underlying encoder/decoder instances (#407)
      try { await conversion.cancel(); } catch (_) { /* already torn down */ }
      throw err;
    }
    return new Blob([output.target.buffer], { type: fmt.mime });
  };

  // Trim a decoded AudioBuffer (starting at `ts` seconds on the original
  // timeline) to its overlap with [start, end), sample-accurately.
  const trimBufferToRange = (buffer, ts, start, end) => {
    const bufEnd = ts + buffer.duration;
    const from = Math.max(ts, start);
    const to = Math.min(bufEnd, end);
    if (to <= from) return null;
    if (from <= ts && to >= bufEnd) return buffer;
    const sr = buffer.sampleRate;
    const s = Math.max(0, Math.round((from - ts) * sr));
    const e = Math.min(buffer.length, Math.round((to - ts) * sr));
    if (e <= s) return null;
    const out = new AudioBuffer({ length: e - s, numberOfChannels: buffer.numberOfChannels, sampleRate: sr });
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      out.copyToChannel(buffer.getChannelData(c).subarray(s, e), c);
    }
    return out;
  };

  // Pitch-preserved time-stretch (SoundTouch/WSOLA): tempo = rate, so 1.5×
  // yields audio 1/1.5 the length at the original pitch — matching what the
  // player's preservesPitch playback sounds like. The incremental pipeline
  // (#405) lives in stream-stretch.js: push() trimmed buffers as they decode
  // and stretched blocks are emitted as soon as SoundTouch produces them;
  // flush() drains the pipeline at the end.
  const startStreamStretcher = async (rate, emit) =>
    makeStreamStretcher(await loadSoundtouch(), rate, emit);

  /* --------------------------------------------------------------------------
   * Encoder input rate (#579). WebKit's WebCodecs AudioEncoder picks HE-AAC
   * for MONO input below 32 kHz — a sharp, measured boundary — and the muxed
   * track that results is unreadable to AVFoundation: zero audio tracks, so
   * the export is SILENT in QuickTime, Safari and Finder preview while
   * appearing to have succeeded. Voice notes, telephony, voicemail and much
   * interview audio live below that line. Chrome is unaffected; this is
   * WebKit's encoder choice.
   *
   * Forcing the codec string to mp4a.40.2 does NOT help — measured: WebKit
   * emits HE-AAC regardless while describing it as LC, so the muxed
   * configuration disagrees with the samples either way.
   *
   * So low-rate audio is lifted before it reaches the encoder. 32 kHz encodes
   * as AAC-LC across bitrates (verified at QUALITY_LOW/MEDIUM/HIGH and
   * 32/64/128 kbps), but we lift clear of that cliff rather than onto it, and
   * prefer a target the source divides into exactly — 8/12/16/24 kHz into
   * 48 kHz, 11.025/22.05 into 44.1 — which keeps the resampling arithmetic
   * simple. Upsampling cannot restore bandwidth the source never had, and it
   * cannot lose any either. Applied on every engine: skipping it by sniffing
   * for WebKit would risk guessing wrong about some variant, and the early
   * return means anything at 32 kHz or above pays nothing.
   * ------------------------------------------------------------------------ */
  const MIN_ENCODE_RATE = 32000;     // below this WebKit picks HE-AAC for mono
  const liftTargetFor = (rate) => (44100 % rate === 0 ? 44100 : 48000);

  const liftForEncoder = async (buffer) => {
    if (!buffer || buffer.sampleRate >= MIN_ENCODE_RATE) return buffer;
    const target = liftTargetFor(buffer.sampleRate);
    try {
      const frames = Math.max(1, Math.round(buffer.length * target / buffer.sampleRate));
      const ctx = new OfflineAudioContext(buffer.numberOfChannels, frames, target);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start();
      return await ctx.startRendering();
    } catch (e) {
      // A silent export is bad; breaking an export that used to work is worse.
      console.warn('media-export: could not lift audio to ' + target + ' Hz — encoding at the source rate', e);
      return buffer;
    }
  };

  // Edited media, audio-only: decode each kept section, trim the edge buffers,
  // append. AudioBufferSource plays appended buffers back-to-back from 0, so
  // the sections concatenate without any timestamp bookkeeping.
  const exportEditedAudio = async (mb, fmt, ctx, onProgress) => {
    const { sections, rate } = ctx;
    const input = await makeInput(mb, ctx);
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('The media has no audio track.');

    const sink = new mb.AudioBufferSink(track);
    const output = new mb.Output({ format: fmt.make(mb), target: new mb.BufferTarget() });
    const source = new mb.AudioBufferSource({ codec: fmt.codec, bitrate: audioBitrate(mb) });
    output.addAudioTrack(source);
    await output.start();

    try {
      const total = keptDuration(sections);
      let done = 0;
      // Every buffer reaches the encoder through here — the direct branch AND
      // the stretcher's emit — so the lift (#579) cannot be missed by a call
      // site. Deliberately AFTER the stretcher: SoundTouch keeps working on
      // the smaller source-rate buffers rather than three times the samples.
      const addAudio = async (b) => { await source.add(await liftForEncoder(b)); };
      const stretcher = rate !== 1 ? await startStreamStretcher(rate, addAudio) : null;
      for (const sec of sections) {
        for await (const wrapped of sink.buffers(sec.start, sec.end)) {
          const trimmed = trimBufferToRange(wrapped.buffer, wrapped.timestamp, sec.start, sec.end);
          if (trimmed !== null) {
            if (stretcher !== null) {
              await stretcher.push(trimmed);
            } else {
              await addAudio(trimmed);
            }
            done += trimmed.duration;
            onProgress(Math.min(0.99, done / total));
          }
        }
      }
      if (stretcher !== null) await stretcher.flush();
      source.close();
      await output.finalize();
    } catch (err) {
      // release the underlying encoder instances (#407)
      try { await output.cancel(); } catch (_) { /* already torn down */ }
      throw err;
    }
    return new Blob([output.target.buffer], { type: fmt.mime });
  };

  // Edited media with video: decode frames per kept section and re-timestamp
  // them onto the edited timeline; audio as above (its appended timestamps
  // already match the edited timeline).
  // Portrait and square output (#690). The output's size, and how each
  // source frame is placed in it: 'crop' fills the frame, cutting the sides
  // (or top and bottom) with `position` 0..1 choosing what is kept; 'fit'
  // shows the whole picture over a blurred, darkened copy of itself.
  const FRAME_SIZES = { portrait: { w: 1080, h: 1920 }, square: { w: 1080, h: 1080 } };
  const outputSize = (frame, srcW, srcH) =>
    (frame && FRAME_SIZES[frame.aspect]) || { w: srcW, h: srcH };

  // The part of a srcW x srcH frame that fills a W x H output: [sx, sy, sw, sh]
  const coverRegion = (srcW, srcH, W, H, position) => {
    const scale = Math.max(W / srcW, H / srcH);
    const sw = Math.min(srcW, W / scale);
    const sh = Math.min(srcH, H / scale);
    const p = Math.min(1, Math.max(0, position === undefined ? 0.5 : position));
    return [(srcW - sw) * p, (srcH - sh) * p, sw, sh];
  };
  // Where a whole srcW x srcH frame sits inside a W x H output: [dx, dy, dw, dh]
  const containRegion = (srcW, srcH, W, H) => {
    const scale = Math.min(W / srcW, H / srcH);
    const dw = srcW * scale;
    const dh = srcH * scale;
    return [(W - dw) / 2, (H - dh) / 2, dw, dh];
  };

  // Where the WHOLE srcW x srcH frame must be drawn so that the region
  // coverRegion() selects lands exactly on a W x H canvas: [dx, dy, dw, dh].
  // The canvas edge then does the cropping. WebKit ignores a SOURCE rectangle
  // when the source is a VideoFrame (#711), and honours a destination one.
  const coverPlacement = (srcW, srcH, W, H, position) => {
    const [sx, sy, sw, sh] = coverRegion(srcW, srcH, W, H, position);
    const kx = W / sw;
    const ky = H / sh;
    return [-sx * kx, -sy * ky, srcW * kx, srcH * ky];
  };

  // Draws one decoded sample into the output canvas as the frame settings say.
  // Never with a source rectangle — see coverPlacement.
  // The blur behind a fitted picture is the frame drawn tiny and scaled back
  // up — cheap per frame, and independent of canvas filter support.
  const makeFrameDrawer = (frame, srcW, srcH, W, H) => {
    if (!frame || frame.aspect === 'original' || !FRAME_SIZES[frame.aspect]) {
      return (sample, c) => sample.draw(c, 0, 0, W, H);
    }
    if (frame.fit !== 'fit') {
      const [dx, dy, dw, dh] = coverPlacement(srcW, srcH, W, H, frame.position);
      return (sample, c) => sample.draw(c, dx, dy, dw, dh);
    }
    const bg = document.createElement('canvas');
    bg.width = Math.max(8, Math.round(W / 24));
    bg.height = Math.max(8, Math.round(H / 24));
    const bgCtx = bg.getContext('2d');
    const [bx, by, bw, bh] = coverPlacement(srcW, srcH, bg.width, bg.height, 0.5);
    const [dx, dy, dw, dh] = containRegion(srcW, srcH, W, H);
    return (sample, c) => {
      sample.draw(bgCtx, bx, by, bw, bh);
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'high';
      c.drawImage(bg, 0, 0, W, H);
      c.fillStyle = 'rgba(0,0,0,0.45)';
      c.fillRect(0, 0, W, H);
      sample.draw(c, dx, dy, dw, dh);
    };
  };

  const exportEditedVideo = async (mb, fmt, ctx, onProgress, captions) => {
    const { sections, rate } = ctx;
    const input = await makeInput(mb, ctx);
    const vTrack = await input.getPrimaryVideoTrack();
    const aTrack = await input.getPrimaryAudioTrack();
    if (!vTrack) throw new Error('The media has no video track.');

    const output = new mb.Output({ format: fmt.make(mb), target: new mb.BufferTarget() });

    // Route frames through a canvas rather than re-encoding the decoded samples
    // directly: it normalises exotic source colour spaces (e.g. sRGB-tagged
    // sources make VP9 profile-0 encoding fail) and gives explicit control of
    // the output timestamps for the edited timeline.
    const vSink = new mb.VideoSampleSink(vTrack);
    const probe = await vSink.getSample(sections[0].start);
    const srcW = (probe && (probe.displayWidth || probe.codedWidth)) || 640;
    const srcH = (probe && (probe.displayHeight || probe.codedHeight)) || 360;
    if (probe) probe.close();
    const { w: width, h: height } = outputSize(ctx.frame, srcW, srcH);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext('2d');
    const drawFrame = makeFrameDrawer(ctx.frame, srcW, srcH, width, height);

    const vSource = new mb.CanvasSource(canvas, { codec: fmt.vcodec, bitrate: videoBitrate(mb) });
    output.addVideoTrack(vSource);
    let aSource = null;
    let aSink = null;
    if (aTrack) {
      aSource = new mb.AudioBufferSource({ codec: fmt.acodec, bitrate: audioBitrate(mb) });
      output.addAudioTrack(aSource);
      aSink = new mb.AudioBufferSink(aTrack);
    }
    await output.start();

    try {
      const total = keptDuration(sections) * (aTrack ? 2 : 1);
      let done = 0;
      let offset = 0;
      let prevT = -1;

      for (const sec of sections) {
        for await (const sample of vSink.samples(sec.start, sec.end)) {
          // close the in-flight sample even when draw()/add() throws (#407);
          // the early close after draw keeps the decoder's frame pool moving
          let closed = false;
          try {
            // clamp the first frame (which may start before the section), map onto
            // the edited timeline (÷ rate when applying the playback speed), and
            // keep timestamps strictly increasing across section boundaries
            let t = (offset + Math.max(0, sample.timestamp - sec.start)) / rate;
            if (t <= prevT) t = prevT + 0.001;
            prevT = t;
            const frameDur = Math.max(sample.duration || 1 / 30, 0.001) / rate;
            drawFrame(sample, ctx2d);
            sample.close();
            closed = true;
            if (captions) drawCaptionOverlay(ctx2d, t, captions, width, height);
            await vSource.add(t, frameDur);
            done += frameDur * rate;
            onProgress(Math.min(0.99, done / total));
          } finally {
            if (!closed) sample.close();
          }
        }
        offset += sec.end - sec.start;
      }
      vSource.close();

      if (aSink !== null) {
        const addAudio = async (b) => { await aSource.add(await liftForEncoder(b)); };
        const stretcher = rate !== 1 ? await startStreamStretcher(rate, addAudio) : null;
        for (const sec of sections) {
          for await (const wrapped of aSink.buffers(sec.start, sec.end)) {
            const trimmed = trimBufferToRange(wrapped.buffer, wrapped.timestamp, sec.start, sec.end);
            if (trimmed !== null) {
              if (stretcher !== null) {
                await stretcher.push(trimmed);
              } else {
                await addAudio(trimmed);
              }
              done += trimmed.duration;
              onProgress(Math.min(0.99, done / total));
            }
          }
        }
        if (stretcher !== null) await stretcher.flush();
        aSource.close();
      }

      await output.finalize();
    } catch (err) {
      // release the underlying encoder instances (#407)
      try { await output.cancel(); } catch (_) { /* already torn down */ }
      throw err;
    }
    return new Blob([output.target.buffer], { type: fmt.mime });
  };

  // ---------------------------------------------------------------------------
  // Downloads
  // ---------------------------------------------------------------------------

  /* --------------------------------------------------------------------------
   * Exported-page identity (#563): the project's title in the tab, in an
   * unfurl, and on the page itself — every export was previously anonymous
   * boilerplate. The description is the transcript's opening words, which is
   * what a reader (or a link preview) needs to recognise it.
   *
   * Shared with the plain Interactive Transcript modal in editor-core, so
   * both routes produce the same page: one filler, two callers.
   * ------------------------------------------------------------------------ */
  const escapeAttr = (text) => String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // The transcript's opening words, trimmed to a sentence-ish length.
  const openingWords = (transcriptHtml) => {
    const host = document.createElement('div');
    host.innerHTML = transcriptHtml || '';
    // speakers are labels, not speech — the description reads better without
    host.querySelectorAll('.speaker').forEach((el) => el.remove());
    const text = host.textContent.replace(/\s+/g, ' ').trim();
    if (text === '') return '';
    if (text.length <= 160) return text;
    const cut = text.slice(0, 160);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 80 ? cut.slice(0, lastSpace) : cut) + '…';
  };

  // title: the captured one during a run (#656); the live project's for the
  // plain HTML export in editor-core, which reads the editor as it stands.
  const fillExportIdentity = (html, transcriptHtml, title) => {
    if (title === undefined) title = exportTitle();
    const description = openingWords(transcriptHtml);
    const pageTitle = title !== '' ? title : 'Hyperaudio – Interactive Transcript';
    return html
      .replace(/\{title\}/g, () => escapeAttr(pageTitle))
      .replace(/\{description\}/g, () => escapeAttr(description))
      // an untitled export drops the heading element rather than showing an
      // empty one — no gap, no lonely rule above the player
      .replace(/\s*<h1 class="ht-title">\{heading\}<\/h1>/,
        () => (title !== '' ? '\n    <h1 class="ht-title">' + escapeAttr(title) + '</h1>' : ''));
  };
  window.fillExportIdentity = fillExportIdentity;

  // The project's own title, before it is reduced to a filename.
  const exportTitle = () => {
    const title = (window.HyperaudioSave && typeof window.HyperaudioSave.getProjectTitle === 'function')
      ? window.HyperaudioSave.getProjectTitle() : '';
    return title.trim();
  };

  const exportBaseName = () => {
    // the Recents list is gone (#451); the project session names exports now
    const title = (window.HyperaudioSave && typeof window.HyperaudioSave.getProjectTitle === 'function')
      ? window.HyperaudioSave.getProjectTitle() : '';
    const name = title.trim() !== '' ? title.trim() : 'hyperaudio';
    return name.replace(/\.[a-z0-9]+$/i, '');
  };

  // Bundle the run's outputs into one archive (#396). Everything goes inside a
  // single top-level FOLDER, which is the point: the interactive transcript
  // links its media by bare filename, and handing the browser several downloads
  // lets its de-duplication rename one of them — "clip.mp4" arrives as
  // "clip (1).mp4" when Downloads already holds that name, and the transcript
  // then silently plays whatever the older file was. Archive entries can't be
  // renamed that way, and if the FOLDER collides on extraction it is the folder
  // that gets suffixed while its contents keep their names and pairing.
  //
  // STORE, not deflate: the payload is already-compressed media, so compressing
  // buys nothing and costs time on large exports.
  /* --------------------------------------------------------------------------
   * Export filenames (#560). The interactive transcript links its media by
   * bare filename, so whatever we WRITE has to be safe as both a filename and
   * a URL path segment — otherwise the page carries "media%20file.mp4" while
   * the disk holds "media file.mp4", and static hosts, CDNs and equality
   * checks each handle that pair differently.
   *
   * One helper, every call site: spaces (and runs of them) become single
   * underscores, filesystem/URL-hostile characters go, and leading dots are
   * dropped so nothing exports as a hidden file. The user's own media and
   * project titles are untouched — this only names the files we produce.
   * ------------------------------------------------------------------------ */
  const safeExportName = (name, fallback) => {
    const cleaned = String(name === undefined || name === null ? '' : name)
      .normalize('NFC')
      .replace(/[\/\\:*?"<>|#%&{}$!'`+=@]+/g, '')  // hostile in a path, a URL, or a shell
      .replace(/\s+/g, '_')                        // no percent-encoding needed anywhere
      .replace(/_+/g, '_')
      .replace(/^[._-]+/, '')                      // no hidden files, no leading noise
      .replace(/[._-]+$/, '')
      .trim();
    // an explicit '' fallback means "tell me there was nothing": the callers
    // that name downloads from the project title check for it, and then keep
    // the name their markup gives; it used to be taken for "no fallback"
    return cleaned !== '' ? cleaned : (fallback === undefined ? 'hyperaudio-export' : fallback);
  };
  window.safeExportName = safeExportName;

  const zipFolderName = (name) => safeExportName(name, 'hyperaudio-export');

  const buildOutputsZip = async (outputs, baseName, onProgress) => {
    if (!window.HyperaudioSave || typeof window.HyperaudioSave.loadJSZip !== 'function') {
      throw new Error('zip writer unavailable');
    }
    const JSZipImpl = await window.HyperaudioSave.loadJSZip();
    const zip = new JSZipImpl();
    const folder = zip.folder(zipFolderName(baseName));
    outputs.forEach((out) => folder.file(out.name, out.blob));
    return zip.generateAsync(
      { type: 'blob', compression: 'STORE' },
      (meta) => { if (typeof onProgress === 'function' && meta) onProgress(meta.percent || 0); }
    );
  };

  const downloadBlob = (blob, filename) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  };

  // ---------------------------------------------------------------------------
  // Modal UI
  // ---------------------------------------------------------------------------

  const modalToggle = document.getElementById('export-modal');
  const formatSelect = document.getElementById('export-format');
  const nameInput = document.getElementById('export-name');
  const sourceEntire = document.getElementById('export-source-entire');
  const sourceEdited = document.getElementById('export-source-edited');
  const editSummary = document.getElementById('export-edit-summary');
  const sourceClip = document.getElementById('export-source-clip');
  const clipRow = document.getElementById('export-source-clip-row');
  const clipSummary = document.getElementById('export-clip-summary');

  // The transcript selection as a stretch of media (#689), from
  // js/transcript-selection.js; without that module, no clip is offered.
  const selectedClip = (duration) => (window.TranscriptSelection
    ? window.TranscriptSelection.range(duration) : null);
  let clipRange = null;   // the selection as it was when the dialog opened
  const clipChosen = () => sourceClip !== null && sourceClip.checked && clipRange !== null;
  const adjustRow = document.getElementById('export-adjust-row');
  const adjustCheck = document.getElementById('export-adjust');
  const adjustPanel = document.getElementById('export-adjust-panel');
  const speedInput = document.getElementById('export-speed');
  const speedSlider = document.getElementById('export-speed-slider');
  const lengthMinInput = document.getElementById('export-length-min');
  const lengthSecInput = document.getElementById('export-length-sec');
  const lengthOrigEl = document.getElementById('export-length-orig');
  const adjustReadout = document.getElementById('export-adjust-readout');
  const retimeRow = document.getElementById('export-retime-row');
  const retimeCheck = document.getElementById('export-retime');
  const vttRow = document.getElementById('export-vtt-row');
  const vttCheck = document.getElementById('export-vtt');
  const zipRow = document.getElementById('export-zip-row');
  const zipCheck = document.getElementById('export-zip');
  const nameNote = document.getElementById('export-name-note');
  const destRow = document.getElementById('export-dest-row');
  const destRecents = document.getElementById('export-dest-recents');
  const destDownload = document.getElementById('export-dest-download');
  const openProjectBtn = document.getElementById('export-open-project');
  // Add to Recents (#693): offered when the project library can take a new
  // project, and there is a transcript to make one of
  const libraryAvailable = () => !!(window.HyperaudioSave && window.HyperaudioSave.library
    && typeof window.HyperaudioSave.library.addFlattened === 'function'
    && window.HyperaudioSave.library.available());
  const toRecents = () => destRecents !== null && destRecents.checked
    && destRow !== null && destRow.style.display !== 'none';
  const srtRow = document.getElementById('export-srt-row');
  const srtCheck = document.getElementById('export-srt');
  const projectRow = document.getElementById('export-project-row');
  const projectCheck = document.getElementById('export-project');
  const burnRow = document.getElementById('export-burn-row');
  const burnCheck = document.getElementById('export-burn');
  const progressBar = document.getElementById('export-progress');
  const statusEl = document.getElementById('export-status');
  const startBtn = document.getElementById('export-start');

  if (modalToggle === null || startBtn === null) return;

  let exporting = false;

  const setStatus = (text) => { statusEl.textContent = text || ''; };
  const setProgress = (fraction) => {
    if (fraction === null) {
      progressBar.style.visibility = 'hidden';
      progressBar.value = 0;
    } else {
      progressBar.style.visibility = 'visible';
      progressBar.value = Math.round(fraction * 100);
    }
  };

  const playbackRate = () => {
    const player = document.getElementById('hyperplayer');
    const r = player !== null ? player.playbackRate : 1;
    return r > 0 ? r : 1;
  };

  // --- speed / length ("stretch to fit") ------------------------------------
  const RATE_MIN = 0.25, RATE_MAX = 4;
  const clampRate = (r) => (r > 0 ? Math.min(RATE_MAX, Math.max(RATE_MIN, r)) : 1);
  const adjustApplied = () =>
    adjustRow !== null && adjustRow.style.display !== 'none' && adjustCheck.checked;
  const exportRate = () => (adjustApplied() ? clampRate(parseFloat(speedInput.value)) : 1);

  // The EDITED content length (seconds) is what speed and target-length trade
  // against, so it tracks the Entire/Edited choice.
  const currentContentLength = () => {
    const player = document.getElementById('hyperplayer');
    const dur = player && !isNaN(player.duration) ? player.duration : 0;
    if (!dur) return 0;
    if (clipChosen()) return keptDuration(clipSections(dur, clipRange));
    const edited = sourceEdited.checked && !sourceEdited.disabled;
    return keptDuration(edited ? editedSections(dur) : [{ start: 0, end: dur }]);
  };

  const fmtLen = (s) => {
    s = Math.max(0, Math.round(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  // The target length is entered as SEPARATE minutes/seconds boxes (#441):
  // the old single m:ss text field read a bare "15" as 15 seconds, so a
  // 16-minute video typed as "15" computed a 64x rate, slammed into the 4x
  // cap and rewrote the field to ~4:00 with no explanation. Explicit unit
  // boxes remove the guessing entirely.
  const setLengthBoxes = (secondsTotal) => {
    if (lengthMinInput === null || lengthSecInput === null) return;
    const s = Math.max(0, Math.round(secondsTotal));
    lengthMinInput.value = String(Math.floor(s / 60));
    lengthSecInput.value = String(s % 60);
  };
  const readLengthBoxes = () => {
    if (lengthMinInput === null || lengthSecInput === null) return 0;
    const m = parseInt(lengthMinInput.value, 10);
    const s = parseFloat(lengthSecInput.value);
    // an over-full seconds box (e.g. 90) just rolls over on the reformat
    return (isNaN(m) ? 0 : Math.max(0, m)) * 60 + (isNaN(s) ? 0 : Math.max(0, s));
  };

  // Two fixed lines (white-space:pre-line + reserved min-height in the
  // markup): the outcome on the first, any warning/cap note on the second —
  // variable-length single-line text made the modal reflow.
  const updateAdjustReadout = (capNote = '') => {
    if (adjustReadout === null) return;
    const rate = clampRate(parseFloat(speedInput.value));
    const len = currentContentLength() / rate;
    const warn = (rate < 0.5 || rate > 2) ? '⚠ noticeable quality loss' : '';
    const second = capNote !== '' ? `⚠ ${capNote}` : warn;
    adjustReadout.textContent =
      `→ ${fmtLen(len)} at ${+rate.toFixed(2)}×, pitch preserved` +
      (second !== '' ? `\n${second}` : '');
  };
  // Speed is the source of truth; mirror it to the slider and derive the length.
  const syncFromSpeed = () => {
    const rate = clampRate(parseFloat(speedInput.value));
    speedInput.value = String(+rate.toFixed(2));
    if (speedSlider !== null) speedSlider.value = String(rate);
    setLengthBoxes(currentContentLength() / rate);
    updateAdjustReadout();
  };
  // While the speed is being typed, never write the box back: "1." read as a
  // number is 1, and rewriting it on every keystroke ate the decimal point,
  // so 1.5 or 0.75 could not be typed (and "0" became "1"). Follow a value as
  // soon as it is a valid speed; tidy the box (clamp, two decimals) only when
  // it is left, as the length boxes do (#441).
  const followTypedSpeed = () => {
    const typed = parseFloat(speedInput.value);
    if (!(typed >= RATE_MIN && typed <= RATE_MAX)) return;
    if (speedSlider !== null) speedSlider.value = String(typed);
    setLengthBoxes(currentContentLength() / typed);
    updateAdjustReadout();
  };
  const syncFromSlider = () => {
    speedInput.value = String(+parseFloat(speedSlider.value).toFixed(2));
    syncFromSpeed();
  };
  const syncFromLength = () => {
    const target = readLengthBoxes();
    const content = currentContentLength();
    // When the target can't be met, say WHY in the readout — the old silent
    // snap to the capped value read as a glitch.
    let note = '';
    if (target > 0 && content > 0) {
      const raw = content / target;
      const rate = clampRate(raw);
      speedInput.value = String(+rate.toFixed(2));
      if (speedSlider !== null) speedSlider.value = String(rate);
      if (raw > RATE_MAX) {
        note = `capped at ${RATE_MAX}× — the shortest is ${fmtLen(content / RATE_MAX)}`;
      } else if (raw < RATE_MIN) {
        note = `capped at ${RATE_MIN}× — the longest is ${fmtLen(content / RATE_MIN)}`;
      }
    }
    // The boxes hold the USER'S REQUESTED length and are deliberately not
    // rewritten here — reformatting on every change fought sequential
    // min→sec entry (the min box's change event fires when focus moves on).
    // The readout shows the length actually delivered; only an over-full
    // seconds box (90 → 1:30) is normalised.
    if (lengthSecInput !== null && parseFloat(lengthSecInput.value) >= 60) {
      setLengthBoxes(target);
    }
    updateAdjustReadout(note);
  };
  const updateAdjustVisibility = () => {
    if (adjustPanel === null || adjustCheck === null || adjustRow === null) return;
    adjustPanel.style.display =
      (adjustCheck.checked && adjustRow.style.display !== 'none') ? 'block' : 'none';
  };
  // Content length changed (Entire vs Edited) — refresh the "was m:ss" hint and
  // re-derive the length from the current speed.
  const refreshAdjustForContent = () => {
    if (adjustRow === null) return;
    const orig = currentContentLength();
    if (lengthOrigEl !== null) lengthOrigEl.textContent = orig > 0 ? `(was ${fmtLen(orig)})` : '';
    if (adjustCheck.checked) syncFromSpeed();
  };

  // The re-timed transcript makes sense whenever the exported media's timeline
  // differs from the original: edits, an applied playback speed, or both.
  // The transcript/caption sidecars (interactive transcript, VTT, SRT) are all
  // offered whenever there's a transcript to derive them from — they re-time
  // themselves to whatever edits/speed the export uses.
  // The interactive transcript ships its captions as a sidecar file (#561), so
  // a .vtt is written whether or not this box is ticked — but NOT when the
  // captions are burned into the picture, since then the page carries no
  // <track> at all. The note says so only when it is true, rather than making
  // a blanket claim that is wrong exactly when someone burns captions.
  const updateVttNote = () => {
    const note = document.getElementById('export-vtt-note');
    if (note === null) return;
    const interactive = retimeCheck !== null && retimeCheck.checked && retimeRow.style.display !== 'none';
    const burning = burnCheck !== null && burnCheck.checked && burnRow !== null && burnRow.style.display !== 'none';
    note.style.display = (interactive && !burning) ? '' : 'none';
  };

  const updateRetimeVisibility = () => {
    const show = hasTranscript() ? 'flex' : 'none';
    retimeRow.style.display = show;
    if (vttRow !== null) vttRow.style.display = show;
    if (srtRow !== null) srtRow.style.display = show;
    updateVttNote();
    // the flattened project (#455) needs a transcript to flatten, and the
    // container writer to be loaded
    if (projectRow !== null) {
      projectRow.style.display =
        (show === 'flex' && window.HyperaudioSave
          && typeof window.HyperaudioSave.buildFlattenedProjectBlob === 'function') ? 'flex' : 'none';
    }
    updateZipVisibility();
  };

  // The zip only means anything when the run produces more than one file, so the
  // toggle appears exactly then — and the "keep the downloads together" warning
  // is only true when it is off, since a zip keeps them together by construction.
  const checkedAndVisible = (check, row) =>
    check !== null && check.checked && row !== null && row.style.display !== 'none';

  // The extras disclosure (#616). Closed by default, and it stays closed even
  // when something inside is selected — the COUNT in the summary is what keeps
  // that honest. These options are remembered across sessions, so a panel that
  // hid a ticked option with no sign of it would export more files than the
  // modal appears to offer; "(2 selected)" says so without opening anything.
  //
  // Whether it is open is itself remembered, so someone who works with the
  // sidecars every time is not made to open it every time.
  const extrasBox = document.getElementById('export-extras');
  // Rows another module added to the panel (data-export-extra): an extra file
  // this module does not know about, counted like the ones it does (#668).
  const otherExtraRows = () => (extrasBox === null ? [] : [...extrasBox.querySelectorAll('[data-export-extra]')]);
  const extrasCount = document.getElementById('export-extras-count');
  const zipCount = document.getElementById('export-zip-count');
  const updateExtrasDisclosure = (selected) => {
    if (extrasBox === null) return;
    // zipRow is deliberately NOT here: it lives outside the panel, because
    // packaging is not an extra file and its offer has to be SEEN the moment a
    // second output is chosen — which a closed panel would prevent.
    const applicable = [retimeRow, vttRow, srtRow, projectRow].concat(otherExtraRows())
      .filter((row) => row !== null && row.style.display !== 'none').length;
    extrasBox.style.display = applicable > 0 ? '' : 'none';
    if (extrasCount !== null) {
      extrasCount.textContent = selected > 0 ? ` (${selected} selected)` : '';
    }
  };

  const updateZipVisibility = () => {
    if (zipRow === null) return;
    const extras = [
      checkedAndVisible(retimeCheck, retimeRow),
      checkedAndVisible(vttCheck, vttRow),
      checkedAndVisible(srtCheck, srtRow),
      checkedAndVisible(projectCheck, projectRow),
    ].concat(otherExtraRows().map((row) => checkedAndVisible(row.querySelector('input[type="checkbox"]'), row)))
      .filter(Boolean).length;
    const multi = extras > 0;   // the media itself is always the first output
    zipRow.style.display = multi ? 'flex' : 'none';
    // Name what is being packaged (#616). The options that cause this offer to
    // appear now live in a collapsed panel, so without the count the zip row
    // shows up with no visible cause — "(3 files, one folder)" supplies it
    // without making anyone open the panel to find out why.
    if (zipCount !== null) {
      const files = extras + 1; // the media itself is always the first output
      zipCount.textContent = `(${files} files, one folder)`;
    }
    // counted AFTER the zip row settles, so the summary matches what is shown
    updateExtrasDisclosure(extras);
    if (nameNote !== null) {
      nameNote.textContent = (multi && zipCheck !== null && zipCheck.checked)
        ? 'All exported files use this name. They arrive in one .zip, in a folder that keeps them together.'
        : 'All exported files use this name. The interactive transcript links the video by it — keep the downloads together in one folder.';
    }
    applyDestination();
  };

  // Added to Recents, nothing is downloaded: the downloads' extras and their
  // zip do not apply, and the name is the new project's (#693).
  const applyDestination = () => {
    if (destRow === null) return;
    const recents = toRecents();
    if (recents) {
      if (extrasBox !== null) extrasBox.style.display = 'none';
      if (zipRow !== null) zipRow.style.display = 'none';
      if (nameNote !== null) nameNote.textContent = 'The new project is named this. It appears in Recents; the project you have open stays open.';
    }
    startBtn.textContent = finished ? 'DONE' : (recents ? 'ADD TO RECENTS' : 'EXPORT');
  };

  // A finished run leaves a finished dialog (#693): the button becomes Done,
  // which closes it, rather than a button that would repeat the same long job
  // on a stray second click. The status line keeps what happened, and any
  // change to a setting makes it an export button again, so exporting the
  // same source in another format is one change away.
  let finished = false;
  const setFinished = (on) => { finished = on; applyDestination(); };

  const hasTranscript = () => {
    const t = document.getElementById('hypertranscript');
    return t !== null && t.querySelector('[data-m]') !== null;
  };

  // Burn-in is a video-only, frame-by-frame operation and needs a transcript to
  // draw. Offer it only when both hold (#387 part 2).
  const updateBurnVisibility = () => {
    updateFrameVisibility();
    if (burnRow === null) return;
    const fmt = FORMATS.find((f) => f.id === formatSelect.value);
    const show = fmt && fmt.kind === 'video' && hasTranscript();
    burnRow.style.display = show ? 'flex' : 'none';
  };

  // Portrait and square (#690): offered for video formats
  const frameRow = document.getElementById('export-frame-row');
  const aspectSelect = document.getElementById('export-aspect');
  const framingBox = document.getElementById('export-framing');
  const fitCrop = document.getElementById('export-fit-crop');
  const fitFit = document.getElementById('export-fit-fit');
  const positionRow = document.getElementById('export-position-row');
  const positionInput = document.getElementById('export-position');
  const framePreview = document.getElementById('export-frame-preview');
  const videoChosen = () => {
    const fmt = FORMATS.find((f) => f.id === formatSelect.value);
    return !!(fmt && fmt.kind === 'video');
  };
  // what the export will do with the picture, or null for no change
  const chosenFrame = () => {
    if (frameRow === null || aspectSelect === null || !videoChosen()) return null;
    if (!FRAME_SIZES[aspectSelect.value]) return null;
    return {
      aspect: aspectSelect.value,
      fit: fitFit !== null && fitFit.checked ? 'fit' : 'crop',
      position: positionInput !== null ? Number(positionInput.value) / 100 : 0.5,
    };
  };
  // The player's current frame, framed as the export will frame it, with the
  // same geometry as the export's. It is drawn from a hidden copy of the
  // video seeked to the player's position: a video that has loaded but not
  // yet played or seeked has no decoded picture to draw, which is just how
  // the player sits after a project opens.
  let previewVideo = null;
  let previewReady = false;
  const previewSource = () => {
    const player = document.getElementById('hyperplayer');
    const src = player !== null ? (player.currentSrc || player.src) : '';
    if (!src) return null;
    const at = Math.max(0.1, player.currentTime || 0);
    if (previewVideo === null || previewVideo.dataset.src !== src) {
      previewVideo = document.createElement('video');
      previewVideo.muted = true;
      previewVideo.preload = 'auto';
      previewVideo.playsInline = true;
      previewVideo.dataset.src = src;
      previewReady = false;
      previewVideo.addEventListener('seeked', () => { previewReady = true; drawFramePreview(); });
      previewVideo.addEventListener('loadedmetadata', () => {
        previewVideo.currentTime = Math.min(at, Math.max(0, previewVideo.duration - 0.05));
      });
      previewVideo.src = src;
    } else if (previewReady && Math.abs(previewVideo.currentTime - at) > 0.5
        && Number.isFinite(previewVideo.duration)) {
      previewReady = false;
      previewVideo.currentTime = Math.min(at, Math.max(0, previewVideo.duration - 0.05));
    }
    return previewReady ? previewVideo : null;
  };
  const drawFramePreview = () => {
    const frame = chosenFrame();
    if (framePreview === null || frame === null) return;
    const size = FRAME_SIZES[frame.aspect];
    const pw = frame.aspect === 'portrait' ? 90 : 120;
    const ph = Math.round(pw * size.h / size.w);
    framePreview.width = pw;
    framePreview.height = ph;
    const c = framePreview.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, pw, ph);
    const video = previewSource();
    if (video === null || !video.videoWidth) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (frame.fit === 'fit') {
      const [bx, by, bw, bh] = coverRegion(vw, vh, pw, ph, 0.5);
      c.drawImage(video, bx, by, bw, bh, 0, 0, pw, ph);
      c.fillStyle = 'rgba(0,0,0,0.45)';
      c.fillRect(0, 0, pw, ph);
      const [dx, dy, dw, dh] = containRegion(vw, vh, pw, ph);
      c.drawImage(video, 0, 0, vw, vh, dx, dy, dw, dh);
    } else {
      const [sx, sy, sw, sh] = coverRegion(vw, vh, pw, ph, frame.position);
      c.drawImage(video, sx, sy, sw, sh, 0, 0, pw, ph);
    }
  };
  const updateFrameVisibility = () => {
    if (frameRow === null) return;
    frameRow.style.display = videoChosen() ? '' : 'none';
    const frame = chosenFrame();
    if (framingBox !== null) framingBox.style.display = frame !== null ? 'flex' : 'none';
    if (positionRow !== null) positionRow.style.display = frame !== null && frame.fit === 'crop' ? 'flex' : 'none';
    drawFramePreview();
  };

  // Persist the option toggles so the user's choices stick across sessions.
  // Defaults are all-off; a stored value overrides on open, and any change
  // re-saves. Rate is stored too but only applied when the media isn't at 1×.
  const EXPORT_OPTS_KEY = 'hyperaudioExportOptions';
  const loadExportOpts = () => {
    try { return JSON.parse(window.localStorage.getItem(EXPORT_OPTS_KEY)) || {}; }
    catch (e) { return {}; }
  };
  const saveExportOpts = () => {
    try {
      window.localStorage.setItem(EXPORT_OPTS_KEY, JSON.stringify({
        burn: burnCheck.checked,
        aspect: aspectSelect !== null ? aspectSelect.value : 'original',
        fit: fitFit !== null && fitFit.checked ? 'fit' : 'crop',
        position: positionInput !== null ? Number(positionInput.value) : 50,
        adjust: adjustCheck !== null && adjustCheck.checked,
        speed: adjustCheck !== null ? clampRate(parseFloat(speedInput.value)) : 1,
        retime: retimeCheck.checked,
        vtt: vttCheck !== null && vttCheck.checked,
        srt: srtCheck !== null && srtCheck.checked,
        project: projectCheck !== null && projectCheck.checked,
        extrasOpen: extrasBox !== null && extrasBox.open,
      }));
    } catch (e) { /* storage unavailable (private mode / quota) — non-fatal */ }
  };

  // What the chosen source means for someone's cuts (#608). Only shown when
  // there ARE cuts: with a clean transcript both options produce the same
  // media, and a warning about nothing is the kind people learn to ignore.
  const sourceNote = document.getElementById('export-source-note');
  // The whole option greys out, not just its radio (#608): a disabled input
  // beside a full-strength label still reads as a choice you could make.
  const editedLabel = sourceEdited !== null ? sourceEdited.closest('label') : null;
  const setSourceNote = (edits) => {
    if (sourceNote === null) return;
    sourceNote.style.display = edits ? '' : 'none';
    sourceNote.textContent = edits
      ? 'Entire media exports your file as it is — nothing is cut, and anything struck out is still in it, and in the transcript and captions. Edited media applies the cuts and re-renders the file.'
      : '';
  };

  // The default name follows the source: a clip's carries its start time,
  // "My_Interview-0m42s". It is swapped when the source changes only while the
  // box still holds the default, never over a name someone typed.
  let defaultName = '';
  const nameForSource = () => {
    const base = exportBaseName();
    if (!clipChosen()) return base;
    const s = Math.round(clipRange.from);   // the first word's own start
    return `${base}-${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  };
  const applyDefaultName = (force) => {
    if (nameInput === null) return;
    if (force || nameInput.value === defaultName) nameInput.value = nameForSource();
    defaultName = nameForSource();
  };

  const populateModal = async () => {
    setStatus('');
    setProgress(null);
    startBtn.classList.remove('btn-disabled');

    // edited availability
    const player = document.getElementById('hyperplayer');
    const duration = player && !isNaN(player.duration) ? player.duration : Infinity;
    const sections = editedSections(duration);
    const edits = hasEdits(sections, duration);
    sourceEdited.disabled = !edits;
    if (editedLabel !== null) editedLabel.classList.toggle('export-source-off', !edits);
    setSourceNote(edits);
    if (edits) {
      const saved = duration - keptDuration(sections);
      editSummary.textContent = `(${sections.length - 1} cut${sections.length - 1 === 1 ? '' : 's'}, saves ${saved.toFixed(1)}s)`;
      sourceEdited.checked = true;
    } else {
      editSummary.textContent = '(no strikeouts or skipped silences)';
      sourceEntire.checked = true;
    }

    setFinished(false);
    formatSwapped = false;

    // where the result goes (#693): Download unless changed, every time
    if (destRow !== null) destRow.style.display = libraryAvailable() && hasTranscript() ? '' : 'none';
    if (destDownload !== null) destDownload.checked = true;
    if (openProjectBtn !== null) openProjectBtn.style.display = 'none';

    // a selection in the transcript is offered as a clip, and chosen (#689)
    clipRange = selectedClip(duration);
    if (clipRow !== null) clipRow.style.display = clipRange !== null ? 'flex' : 'none';
    if (clipRange !== null && sourceClip !== null) {
      const len = keptDuration(clipSections(duration, clipRange));
      // the selected words' own times (the padding is ours, not theirs), and
      // the length that will be exported
      if (clipSummary !== null) clipSummary.textContent = `(${fmtLen(clipRange.from)}–${fmtLen(clipRange.to)}, ${fmtLen(len)})`;
      sourceClip.checked = true;
    } else if (sourceClip !== null) {
      sourceClip.checked = false;
    }

    // default the export name to the project/media base name
    applyDefaultName(true);

    // restore the user's last export-option choices (default: all off)
    const opts = loadExportOpts();
    burnCheck.checked = opts.burn === true;
    if (aspectSelect !== null) aspectSelect.value = FRAME_SIZES[opts.aspect] ? opts.aspect : 'original';
    if (fitFit !== null && fitCrop !== null) {
      fitFit.checked = opts.fit === 'fit';
      fitCrop.checked = opts.fit !== 'fit';
    }
    if (positionInput !== null) positionInput.value = String(Number.isFinite(opts.position) ? opts.position : 50);
    retimeCheck.checked = opts.retime === true;
    if (vttCheck !== null) vttCheck.checked = opts.vtt === true;
    if (srtCheck !== null) srtCheck.checked = opts.srt === true;
    if (projectCheck !== null) projectCheck.checked = opts.project === true;
    if (extrasBox !== null) extrasBox.open = opts.extrasOpen === true;

    // speed / length: offer it whenever there's media; restore the toggle and
    // the last speed, defaulting to the player's current rate so a playback
    // speed set in the editor still carries into the export.
    if (adjustRow !== null) {
      adjustRow.style.display = currentContentLength() > 0 ? 'flex' : 'none';
      adjustCheck.checked = opts.adjust === true;
      const startSpeed = clampRate(typeof opts.speed === 'number' ? opts.speed : playbackRate());
      speedInput.value = String(+startSpeed.toFixed(2));
      refreshAdjustForContent();
      syncFromSpeed();
      updateAdjustVisibility();
    }
    updateRetimeVisibility();

    // formats, gated by what this browser can encode
    setStatus('Checking available formats…');
    formatSelect.innerHTML = '';
    try {
      const mb = await loadMediabunny();
      const withVideo = sourceHasVideo();
      const options = [];
      for (const fmt of FORMATS) {
        if (fmt.kind === 'video' && !withVideo) continue;
        let ok;
        if (fmt.kind === 'audio') {
          ok = fmt.needsMp3 ? (await ensureMp3Encoder(mb)) && (await canEncodeAudio(mb, fmt.codec)) : await canEncodeAudio(mb, fmt.codec);
        } else {
          ok = (await canEncodeVideo(mb, fmt.vcodec)) && (await canEncodeAudio(mb, fmt.acodec));
        }
        if (ok) {
          const option = document.createElement('option');
          option.value = fmt.id;
          option.textContent = fmt.label;
          options.push(option);
        }
      }
      // append atomically so the list is never seen half-populated
      options.forEach((o) => formatSelect.appendChild(o));
      // default to a video format when the source has video: MP4, or WebM
      // where the browser cannot encode H.264/AAC (Chromium on Linux, #706).
      // Falling through to the first option, WAV, dropped the picture — and
      // failed outright for a video with no sound.
      if (withVideo) {
        const video = ['mp4', 'webm'].find((id) => formatSelect.querySelector(`option[value="${id}"]`) !== null);
        if (video !== undefined) formatSelect.value = video;
      }
      updateBurnVisibility();
      setStatus('');
    } catch (e) {
      console.error(e);
      setStatus('Could not load the export library — check your connection and try again.');
      startBtn.classList.add('btn-disabled');
    }
  };

  const runExport = async () => {
    if (exporting) return;
    const fmt = FORMATS.find((f) => f.id === formatSelect.value);
    if (!fmt) return;
    exporting = true;
    startBtn.classList.add('btn-disabled');
    setProgress(0);

    // Everything the run needs, read before its first await (#656): from here
    // the editor may be edited or switched to another project, and none of
    // that reaches the outputs.
    const recents = toRecents();
    const frame = chosenFrame();
    if (openProjectBtn !== null) openProjectBtn.style.display = 'none';
    const clip = clipChosen() ? clipRange : null;
    const edited = clip === null && sourceEdited.checked && !sourceEdited.disabled;
    const rate = exportRate();
    const rateLabel = +rate.toFixed(2);
    const burn = fmt.kind === 'video' && burnRow !== null &&
      burnRow.style.display !== 'none' && burnCheck.checked;
    const wantRetime = retimeCheck.checked && retimeRow.style.display !== 'none';
    const wantVtt = vttCheck !== null && vttCheck.checked && vttRow.style.display !== 'none';
    const wantSrt = srtCheck !== null && srtCheck.checked && srtRow.style.display !== 'none';
    const wantProject = projectCheck !== null && projectCheck.checked
      && projectRow !== null && projectRow.style.display !== 'none';
    const wantZip = zipCheck !== null && zipCheck.checked;
    // user-chosen export name (verbatim, so the media file and the transcript's
    // <video src> always agree); light sanitise for filename safety
    const rawName = nameInput !== null ? nameInput.value.trim() : '';
    // Sanitised once, here: the media file, the sidecar captions, the
    // transcript page and the archive folder all derive from this, so the
    // bundle stays internally consistent and needs no encoding (#560).
    const baseName = safeExportName(rawName || exportBaseName(), 'export');

    const player = document.getElementById('hyperplayer');
    const duration = player && !isNaN(player.duration) ? player.duration : Infinity;
    const sections = clip !== null ? clipSections(duration, clip)
      : edited ? editedSections(duration) : [{ start: 0, end: duration }];
    if (clip !== null && keptDuration(sections) < 0.05) {
      setStatus('Nothing to export: everything in the selection is struck out.');
      setProgress(null);
      exporting = false;
      startBtn.classList.remove('btn-disabled');
      return;
    }
    const ctx = Object.freeze(captureContext({
      sections, rate, dropStruck: edited || clip !== null, withProject: wantProject || recents, clip, frame,
    }));

    try {
      const mb = await loadMediabunny();
      if (fmt.needsMp3) await ensureMp3Encoder(mb);

      // 1. the media file. Burning captions requires the frame-by-frame canvas
      // path, so it always routes through the section pipeline (as an applied
      // speed does), even for an unedited "entire" export at 1×.
      let blob;
      // a new aspect ratio redraws every frame, as burning captions does
      const straightCopy = !edited && clip === null && rate === 1 && !burn && frame === null;
      if (straightCopy) {
        setStatus('Exporting entire media…');
        blob = await exportEntire(mb, fmt, ctx, setProgress);
      } else {
        const captions = burn ? buildCaptionChunks(ctx) : null;
        setStatus(burn ? 'Exporting with captions…'
          : (rate !== 1 ? `Exporting at ${rateLabel}× — pitch preserved…`
            : (clip !== null ? 'Exporting clip…' : 'Exporting edited media…')));
        blob = fmt.kind === 'video'
          ? await exportEditedVideo(mb, fmt, ctx, setProgress, captions)
          : await exportEditedAudio(mb, fmt, ctx, setProgress);
      }
      const mediaName = `${baseName}.${fmt.ext}`;

      // 1b. Add to Recents (#693): the render becomes a project of its own,
      // written into the library without opening it; nothing is downloaded
      if (recents) {
        setStatus('Adding to Recents…');
        const html = buildRetimedTranscriptHtml(ctx);
        if (html === null) throw new Error('there is no transcript to make a project of');
        const subs = genRetimedCaptions(ctx);
        const dur = keptDuration(sections) / rate;
        const title = rawName || exportBaseName();
        const id = await window.HyperaudioSave.library.addFlattened({
          html,
          captionsVtt: subs && subs.vtt ? subs.vtt : '',
          media: {
            name: mediaName,
            data: blob,
            mimeType: fmt.mime,
            durationSeconds: Number.isFinite(dur) ? Math.round(dur * 1000) / 1000 : 0,
          },
          title,
          base: ctx.project,   // the state captured at the click (#656)
        });
        setProgress(1);
        setStatus(`Added to Recents as “${title}”.`);
        setFinished(true);
        if (openProjectBtn !== null) {
          openProjectBtn.dataset.projectId = id;
          openProjectBtn.style.display = '';
        }
        return;
      }

      const outputs = [{ blob, name: mediaName }];

      // 2. caption sidecars + interactive transcript, all re-timed to the export
      if (wantRetime || wantVtt || wantSrt) {
        const subs = genRetimedCaptions(ctx);
        const vttName = `${baseName}.vtt`;
        const srtName = `${baseName}.srt`;
        // The interactive transcript's captions ride as a SIDECAR file, not an
        // inline data: URL (#561). The page has never been self-contained —
        // its media is a separate file beside it, and the bundle ships as one
        // folder — so inlining bought nothing while costing a percent-encoded
        // copy of the whole VTT inside the HTML. Files are also the only shape
        // that extends: a translated transcript means one <track> per
        // language, which no data: URL can express.
        const needVtt = (wantVtt || (wantRetime && !burn)) && subs && subs.vtt;
        if (needVtt) {
          // the FADGI block (#673), when that is switched on: the file the
          // interactive transcript links and the TPME checksum covers
          const vttOut = window.HyperaudioTpme && typeof window.HyperaudioTpme.vttForExport === 'function' && ctx.tpme !== null
            ? await window.HyperaudioTpme.vttForExport(subs.vtt, ctx.tpme) : subs.vtt;
          outputs.push({ blob: new Blob([vttOut], { type: 'text/vtt' }), name: vttName });
        }
        if (wantSrt && subs && subs.srt) {
          outputs.push({ blob: new Blob([subs.srt], { type: 'text/plain' }), name: srtName });
        }
        if (wantRetime) {
          // captions track inside the interactive transcript:
          //   burned in -> none (they are already painted into the video)
          //   otherwise -> link the sidecar .vtt, which ships in the bundle
          let trackSrc = null;
          if (!burn) {
            if (needVtt) trackSrc = vttName; // sanitised already (#560): no encoding needed
          }
          const html = buildInteractiveExportHtml(ctx, mediaName, trackSrc);
          if (html !== null) {
            outputs.push({ blob: new Blob([html], { type: 'text/html' }), name: `${baseName}-transcript.html` });
          }
        }
      }

      // 3. flattened project container (#455): a fresh .hyperaudio in which the
      // render IS the original media, with the re-timed struck-free transcript
      // and matching captions. Cuts are genuinely absent from the media and
      // struck words unrecoverable — the safe-to-share artifact the format
      // doc's § 1.1 caveat points to.
      if (wantProject) {
        setStatus('Building project container…');
        const projHtml = buildRetimedTranscriptHtml(ctx);
        if (projHtml !== null) {
          const projSubs = genRetimedCaptions(ctx);
          const projDur = keptDuration(sections) / rate; // Infinity when metadata never loaded
          // the container's captions carry the FADGI block too (#673) — for
          // whoever unpacks it; the editor strips it again on open — but not
          // the pointer to a sidecar that is not inside the container
          let projVtt = projSubs && projSubs.vtt ? projSubs.vtt : '';
          if (projVtt && window.HyperaudioTpme && typeof window.HyperaudioTpme.vttForExport === 'function' && ctx.tpme !== null) {
            projVtt = await window.HyperaudioTpme.vttForExport(projVtt, Object.assign({}, ctx.tpme, { wanted: false }));
          }
          const projBlob = await window.HyperaudioSave.buildFlattenedProjectBlob({
            html: projHtml,
            captionsVtt: projVtt,
            media: {
              name: mediaName,
              data: blob,
              mimeType: fmt.mime,
              durationSeconds: Number.isFinite(projDur) ? Math.round(projDur * 1000) / 1000 : 0,
            },
            title: baseName,
            base: ctx.project,   // the metadata captured at the click, not the editor's now (#656)
          });
          outputs.push({ blob: projBlob, name: `${baseName}.hyperaudio` });
        }
      }

      // 3b. transcript provenance (#668): one more file describing the ones
      // above — off unless turned on in Settings, and like them built from
      // what was captured at the click
      if (window.HyperaudioTpme && typeof window.HyperaudioTpme.sidecar === 'function' && ctx.tpme !== null) {
        const record = await window.HyperaudioTpme.sidecar(ctx.tpme, outputs, { struckRemoved: edited || clip !== null });
        if (record !== null) outputs.push(record);
      }

      // 4. hand the files to the browser — as one .zip when asked, else each on
      // its own, spaced out so Safari doesn't drop all but the last (#396).
      // Decided by what the run actually produced plus the toggle — NOT by the
      // row's visibility, which is presentation and can lag a programmatic
      // checkbox change that fired no 'change' event.
      const asZip = outputs.length > 1 && wantZip;
      let zipped = false;
      if (asZip) {
        try {
          setStatus('Packaging…');
          const zipBlob = await buildOutputsZip(outputs, baseName, (pct) => {
            setStatus(`Packaging… ${Math.round(pct)}%`);
          });
          downloadBlob(zipBlob, `${baseName}.zip`);
          zipped = true;
        } catch (e) {
          // A failed package must not cost the user the render they just waited
          // for — fall through to the individual downloads instead.
          console.warn('media-export: zip packaging failed, downloading separately', e);
        }
      }
      if (!zipped) {
        for (let i = 0; i < outputs.length; i++) {
          downloadBlob(outputs[i].blob, outputs[i].name);
          if (i < outputs.length - 1) await sleep(250);
        }
      }

      setProgress(1);
      setStatus('Done — check your downloads.');
      setFinished(true);
    } catch (e) {
      console.error(e);
      setStatus('Export failed: ' + (e && e.message ? e.message : e));
    } finally {
      exporting = false;
      startBtn.classList.remove('btn-disabled');
      setTimeout(() => setProgress(null), 1500);
    }
  };

  modalToggle.addEventListener('change', () => { if (modalToggle.checked) populateModal(); });
  [aspectSelect, fitCrop, fitFit].forEach((el) => {
    if (el !== null) el.addEventListener('change', () => { updateFrameVisibility(); saveExportOpts(); });
  });
  if (positionInput !== null) {
    positionInput.addEventListener('input', drawFramePreview);
    positionInput.addEventListener('change', saveExportOpts);
  }
  // A project kept in the library is better small (#693): choosing Add to
  // Recents turns WAV into M4A, and Download turns it back — but only a WAV
  // this rule changed; a format someone picked is theirs.
  let formatSwapped = false;
  const followDestinationFormat = () => {
    const has = (id) => formatSelect.querySelector(`option[value="${id}"]`) !== null;
    if (toRecents()) {
      if (formatSelect.value === 'wav' && has('m4a')) {
        formatSelect.value = 'm4a';
        formatSwapped = true;
      }
    } else if (formatSwapped && formatSelect.value === 'm4a') {
      formatSelect.value = 'wav';
      formatSwapped = false;
    }
    updateBurnVisibility();
    updateVttNote();
  };
  formatSelect.addEventListener('change', () => { formatSwapped = false; });
  [destDownload, destRecents].forEach((radio) => {
    if (radio !== null) radio.addEventListener('change', () => { updateZipVisibility(); followDestinationFormat(); });
  });
  if (openProjectBtn !== null) {
    openProjectBtn.addEventListener('click', async () => {
      const id = openProjectBtn.dataset.projectId;
      if (!id || !window.HyperaudioSave || !window.HyperaudioSave.library) return;
      modalToggle.checked = false;
      modalToggle.dispatchEvent(new Event('change'));
      await window.HyperaudioSave.library.open(id);
    });
  }
  // the zip offer tracks how many files the run will produce, so it has to
  // re-evaluate whenever a sidecar is toggled (and its own state changes the note)
  [retimeCheck, vttCheck, srtCheck, projectCheck, zipCheck].forEach((el) => {
    if (el !== null) el.addEventListener('change', updateZipVisibility);
  });
  // ...and whenever a row another module added is toggled, shown or hidden
  if (extrasBox !== null) {
    extrasBox.addEventListener('change', (event) => {
      if (event.target.closest && event.target.closest('[data-export-extra]') !== null) updateZipVisibility();
    });
  }
  // opening or closing the extras is itself a preference worth keeping (#616)
  if (extrasBox !== null) extrasBox.addEventListener('toggle', saveExportOpts);
  // the note depends on BOTH the interactive transcript and the burn choice
  [retimeCheck, burnCheck].forEach((el) => {
    if (el !== null) el.addEventListener('change', updateVttNote);
  });
  [sourceEntire, sourceEdited, sourceClip].forEach((radio) => {
    if (radio !== null) radio.addEventListener('change', () => { updateRetimeVisibility(); refreshAdjustForContent(); applyDefaultName(false); });
  });
  // the format decides whether burning is even offered, so the note follows it
  formatSelect.addEventListener('change', () => { updateBurnVisibility(); updateVttNote(); });
  if (adjustCheck !== null) {
    adjustCheck.addEventListener('change', () => {
      updateAdjustVisibility();
      if (adjustCheck.checked) syncFromSpeed();
      saveExportOpts();
    });
    speedInput.addEventListener('input', () => { followTypedSpeed(); saveExportOpts(); });
    speedInput.addEventListener('change', () => { syncFromSpeed(); saveExportOpts(); });
    if (speedSlider !== null) speedSlider.addEventListener('input', () => { syncFromSlider(); saveExportOpts(); });
    if (lengthMinInput !== null) lengthMinInput.addEventListener('change', () => { syncFromLength(); saveExportOpts(); });
    if (lengthSecInput !== null) lengthSecInput.addEventListener('change', () => { syncFromLength(); saveExportOpts(); });
  }
  [burnCheck, retimeCheck, vttCheck, srtCheck, projectCheck].forEach((el) => {
    if (el !== null) el.addEventListener('change', saveExportOpts);
  });
  startBtn.addEventListener('click', () => {
    if (!finished) { runExport(); return; }
    modalToggle.checked = false;
    modalToggle.dispatchEvent(new Event('change'));
  });
  const modalBox = startBtn.closest('.modal-box');
  if (modalBox !== null) {
    const reopen = () => { if (finished) setFinished(false); };
    modalBox.addEventListener('change', reopen);
    modalBox.addEventListener('input', reopen);
  }

  // The caption pipeline, exposed (#634). Exports are heavy to drive, and
  // these are the pure parts of what an export says: what the cues are, where
  // they land on the edited timeline, and how they become the picture's
  // chunks. Also the handle to reach for when an export's captions look
  // wrong, rather than inferring it from a finished file.
  // Outside a run there is no captured context: these read the editor as it
  // stands, which is what an export started at that moment would capture.
  const liveContext = (sections, rate, dropStruck) => captureContext({ sections, rate, dropStruck });
  window.MediaExportCaptions = Object.freeze({
    parseVttCues, retimeCues, cuesToVtt, cuesToSrt, cuesToChunks, drawCaptionOverlay,
    retimedCues: (sections, rate) => retimedCues(liveContext(sections, rate, false)),
    genRetimedCaptions: (sections, rate, dropStruck) => genRetimedCaptions(liveContext(sections, rate, dropStruck)),
    buildCaptionChunks: (sections, rate, dropStruck) => buildCaptionChunks(liveContext(sections, rate, dropStruck)),
  });
  // The framing geometry for portrait and square output (#690), pure, so it
  // can be checked without rendering a video
  window.MediaExportFrame = Object.freeze({ FRAME_SIZES, outputSize, coverRegion, coverPlacement, containRegion, makeFrameDrawer, captionLayout });
})();

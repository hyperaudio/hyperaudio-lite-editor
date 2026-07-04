/**
 * media-export.js
 * (C) The Hyperaudio Project
 * @version 0.7.5 — last changed in release 0.7.5
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

  // The player src may be http(s), blob: or data: (local files restored from
  // IndexedDB) — fetch handles all three; mediabunny reads the Blob.
  const makeInput = async (mb) => {
    const src = playerSrc();
    if (!src) throw new Error('No media is loaded.');
    let response;
    try {
      response = await fetch(src);
    } catch (e) {
      // playing cross-origin media needs no CORS, but READING its bytes does
      throw new Error('This media source does not allow cross-origin reading (CORS), so it cannot be exported. Load the file locally and try again.');
    }
    if (!response.ok) throw new Error(`Could not read the media (HTTP ${response.status}).`);
    const blob = await response.blob();
    return new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(blob) });
  };

  const sourceHasVideo = () => {
    const player = document.getElementById('hyperplayer');
    return player !== null && player.videoWidth > 0;
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

  // Clone the transcript with struck words removed and every word's data-m
  // mapped onto the edited timeline (and scaled when the playback speed is
  // applied — data-d shrinks with the sped-up media too). Returns the HTML.
  const buildRetimedTranscriptHtml = (sections, rate) => {
    const transcript = document.getElementById('hypertranscript');
    if (transcript === null) return null;
    const clone = transcript.cloneNode(true);
    clone.querySelectorAll('mark.search-mark').forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
    clone.querySelectorAll('[data-m]').forEach((span) => {
      if ((span.style.textDecoration || '').includes('line-through')) {
        span.remove();
        return;
      }
      const t = parseInt(span.getAttribute('data-m'), 10) / 1000;
      span.setAttribute('data-m', String(Math.round((mapTime(t, sections) / rate) * 1000)));
      if (rate !== 1) {
        const d = parseInt(span.getAttribute('data-d'), 10);
        if (!isNaN(d)) span.setAttribute('data-d', String(Math.round(d / rate)));
      }
    });
    clone.querySelectorAll('p').forEach((p) => {
      if (p.querySelector('[data-m]') === null) p.remove();
    });
    clone.normalize();
    return clone.innerHTML;
  };

  // ---------------------------------------------------------------------------
  // Export pipelines
  // ---------------------------------------------------------------------------

  const audioBitrate = (mb) => (mb.QUALITY_MEDIUM !== undefined ? mb.QUALITY_MEDIUM : 128e3);
  const videoBitrate = (mb) => (mb.QUALITY_MEDIUM !== undefined ? mb.QUALITY_MEDIUM : 2.5e6);

  // Entire media: one straight conversion.
  const exportEntire = async (mb, fmt, onProgress) => {
    const input = await makeInput(mb);
    const output = new mb.Output({ format: fmt.make(mb), target: new mb.BufferTarget() });
    const options = { input, output };
    if (fmt.kind === 'audio') options.video = { discard: true };
    const conversion = await mb.Conversion.init(options);
    conversion.onProgress = (p) => onProgress(p);
    await conversion.execute();
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

  // Concatenate AudioBuffers (same sample rate) into one.
  const concatAudioBuffers = (buffers) => {
    if (buffers.length === 1) return buffers[0];
    const channels = Math.max(...buffers.map((b) => b.numberOfChannels));
    const sampleRate = buffers[0].sampleRate;
    const length = buffers.reduce((sum, b) => sum + b.length, 0);
    const out = new AudioBuffer({ length, numberOfChannels: channels, sampleRate });
    let offset = 0;
    for (const b of buffers) {
      for (let c = 0; c < channels; c++) {
        out.copyToChannel(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), c, offset);
      }
      offset += b.length;
    }
    return out;
  };

  // Pitch-preserved time-stretch (SoundTouch/WSOLA): tempo = rate, so 1.5×
  // yields audio 1/1.5 the length at the original pitch — matching what the
  // player's preservesPitch playback sounds like.
  const timeStretchBuffer = async (buffer, rate) => {
    const st = await loadSoundtouch();
    const shifter = new st.SoundTouch();
    shifter.tempo = rate;
    const source = new st.WebAudioBufferSource(buffer);
    const filter = new st.SimpleFilter(source, shifter);
    const FRAMES = 8192;
    const tmp = new Float32Array(FRAMES * 2); // SoundTouch works in stereo interleaved
    const chunks = [];
    let n;
    while ((n = filter.extract(tmp, FRAMES)) > 0) {
      chunks.push(tmp.slice(0, n * 2));
    }
    let totalFrames = 0;
    for (const c of chunks) totalFrames += c.length / 2;
    const channels = Math.min(2, buffer.numberOfChannels);
    const out = new AudioBuffer({ length: Math.max(1, totalFrames), numberOfChannels: channels, sampleRate: buffer.sampleRate });
    const L = out.getChannelData(0);
    const R = channels > 1 ? out.getChannelData(1) : null;
    let i = 0;
    for (const c of chunks) {
      for (let j = 0; j < c.length; j += 2) {
        L[i] = c[j];
        if (R) R[i] = c[j + 1];
        i++;
      }
    }
    return out;
  };

  // Edited media, audio-only: decode each kept section, trim the edge buffers,
  // append. AudioBufferSource plays appended buffers back-to-back from 0, so
  // the sections concatenate without any timestamp bookkeeping.
  const exportEditedAudio = async (mb, fmt, sections, rate, onProgress) => {
    const input = await makeInput(mb);
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('The media has no audio track.');

    const sink = new mb.AudioBufferSink(track);
    const output = new mb.Output({ format: fmt.make(mb), target: new mb.BufferTarget() });
    const source = new mb.AudioBufferSource({ codec: fmt.codec, bitrate: audioBitrate(mb) });
    output.addAudioTrack(source);
    await output.start();

    const stretch = rate !== 1;
    const total = keptDuration(sections);
    let done = 0;
    const collected = stretch ? [] : null;
    for (const sec of sections) {
      for await (const wrapped of sink.buffers(sec.start, sec.end)) {
        const trimmed = trimBufferToRange(wrapped.buffer, wrapped.timestamp, sec.start, sec.end);
        if (trimmed !== null) {
          if (stretch) {
            collected.push(trimmed);
          } else {
            await source.add(trimmed);
          }
          done += trimmed.duration;
          onProgress(Math.min(0.99, (done / total) * (stretch ? 0.6 : 1)));
        }
      }
    }
    if (stretch) {
      const stretched = await timeStretchBuffer(concatAudioBuffers(collected), rate);
      onProgress(0.9);
      await source.add(stretched);
    }
    source.close();
    await output.finalize();
    return new Blob([output.target.buffer], { type: fmt.mime });
  };

  // Edited media with video: decode frames per kept section and re-timestamp
  // them onto the edited timeline; audio as above (its appended timestamps
  // already match the edited timeline).
  const exportEditedVideo = async (mb, fmt, sections, rate, onProgress) => {
    const input = await makeInput(mb);
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
    const width = (probe && (probe.displayWidth || probe.codedWidth)) || 640;
    const height = (probe && (probe.displayHeight || probe.codedHeight)) || 360;
    if (probe) probe.close();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext('2d');

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

    const stretch = rate !== 1;
    const total = keptDuration(sections) * (aTrack ? 2 : 1);
    let done = 0;
    let offset = 0;
    let prevT = -1;

    for (const sec of sections) {
      for await (const sample of vSink.samples(sec.start, sec.end)) {
        // clamp the first frame (which may start before the section), map onto
        // the edited timeline (÷ rate when applying the playback speed), and
        // keep timestamps strictly increasing across section boundaries
        let t = (offset + Math.max(0, sample.timestamp - sec.start)) / rate;
        if (t <= prevT) t = prevT + 0.001;
        prevT = t;
        const frameDur = Math.max(sample.duration || 1 / 30, 0.001) / rate;
        sample.draw(ctx2d, 0, 0, width, height);
        sample.close();
        await vSource.add(t, frameDur);
        done += frameDur * rate;
        onProgress(Math.min(0.99, done / total));
      }
      offset += sec.end - sec.start;
    }
    vSource.close();

    if (aSink !== null) {
      const collected = stretch ? [] : null;
      for (const sec of sections) {
        for await (const wrapped of aSink.buffers(sec.start, sec.end)) {
          const trimmed = trimBufferToRange(wrapped.buffer, wrapped.timestamp, sec.start, sec.end);
          if (trimmed !== null) {
            if (stretch) {
              collected.push(trimmed);
            } else {
              await aSource.add(trimmed);
            }
            done += trimmed.duration;
            onProgress(Math.min(0.99, done / total));
          }
        }
      }
      if (stretch) {
        await aSource.add(await timeStretchBuffer(concatAudioBuffers(collected), rate));
      }
      aSource.close();
    }

    await output.finalize();
    return new Blob([output.target.buffer], { type: fmt.mime });
  };

  // ---------------------------------------------------------------------------
  // Downloads
  // ---------------------------------------------------------------------------

  const exportBaseName = () => {
    const active = document.querySelector('.file-item.active');
    const name = active !== null && active.textContent.trim() !== '' ? active.textContent.trim() : 'hyperaudio';
    return name.replace(/\.[a-z0-9]+$/i, '');
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
  const sourceEntire = document.getElementById('export-source-entire');
  const sourceEdited = document.getElementById('export-source-edited');
  const editSummary = document.getElementById('export-edit-summary');
  const rateRow = document.getElementById('export-rate-row');
  const rateCheck = document.getElementById('export-rate');
  const rateValue = document.getElementById('export-rate-value');
  const retimeRow = document.getElementById('export-retime-row');
  const retimeCheck = document.getElementById('export-retime');
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

  const rateApplied = () =>
    rateRow.style.display !== 'none' && rateCheck.checked && playbackRate() !== 1;

  // The re-timed transcript makes sense whenever the exported media's timeline
  // differs from the original: edits, an applied playback speed, or both.
  const updateRetimeVisibility = () => {
    const edited = sourceEdited.checked && !sourceEdited.disabled;
    retimeRow.style.display = edited || rateApplied() ? 'flex' : 'none';
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
    if (edits) {
      const saved = duration - keptDuration(sections);
      editSummary.textContent = `(${sections.length - 1} cut${sections.length - 1 === 1 ? '' : 's'}, saves ${saved.toFixed(1)}s)`;
      sourceEdited.checked = true;
    } else {
      editSummary.textContent = '(no strikeouts or skipped silences)';
      sourceEntire.checked = true;
    }

    // offer the playback-speed option when the player isn't at 1×
    const rate = playbackRate();
    if (rate !== 1) {
      rateValue.textContent = `${rate}×`;
      rateRow.style.display = 'flex';
    } else {
      rateRow.style.display = 'none';
      rateCheck.checked = false;
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
      // default to a video format when the source has video
      if (withVideo && formatSelect.querySelector('option[value="mp4"]') !== null) {
        formatSelect.value = 'mp4';
      }
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

    try {
      const mb = await loadMediabunny();
      if (fmt.needsMp3) await ensureMp3Encoder(mb);

      const edited = sourceEdited.checked && !sourceEdited.disabled;
      const rate = rateApplied() ? playbackRate() : 1;
      const baseName = exportBaseName();
      const suffix = `${edited ? '-edited' : ''}${rate !== 1 ? `-${rate}x` : ''}`;
      let blob;

      if (!edited && rate === 1) {
        setStatus('Exporting entire media…');
        blob = await exportEntire(mb, fmt, setProgress);
        downloadBlob(blob, `${baseName}.${fmt.ext}`);
      } else {
        // an applied playback speed also routes the entire media through the
        // section pipeline (one full-length section) so it can be stretched
        const player = document.getElementById('hyperplayer');
        const duration = player && !isNaN(player.duration) ? player.duration : Infinity;
        const sections = edited ? editedSections(duration) : [{ start: 0, end: duration }];
        setStatus(rate !== 1 ? `Exporting at ${rate}× — pitch preserved…` : 'Exporting edited media…');
        blob = fmt.kind === 'video'
          ? await exportEditedVideo(mb, fmt, sections, rate, setProgress)
          : await exportEditedAudio(mb, fmt, sections, rate, setProgress);
        downloadBlob(blob, `${baseName}${suffix}.${fmt.ext}`);

        if (retimeCheck.checked && retimeRow.style.display !== 'none') {
          const html = buildRetimedTranscriptHtml(sections, rate);
          if (html !== null) {
            downloadBlob(new Blob([html], { type: 'text/html' }), `${baseName}${suffix}-transcript.html`);
          }
        }
      }

      setProgress(1);
      setStatus('Done — check your downloads.');
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
  sourceEntire.addEventListener('change', updateRetimeVisibility);
  sourceEdited.addEventListener('change', updateRetimeVisibility);
  rateCheck.addEventListener('change', updateRetimeVisibility);
  startBtn.addEventListener('click', runExport);
})();

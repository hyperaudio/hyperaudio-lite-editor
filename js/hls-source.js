/**
 * hls-source.js
 * (C) The Hyperaudio Project
 * @version 0.6.26 — last changed in release 0.6.26
 * @license MIT
 *
 * Transcribe from a remote media URL — including HLS VOD (.m3u8) — by resolving
 * it to the 16 kHz mono Float32Array the local engines consume (see #358).
 *
 * The audio engines need decodable bytes; an .m3u8 manifest is not that. hls.js
 * fetches and transmuxes the segments (TS or fMP4) into a Media Source buffer,
 * so we tap its appended *audio* data, reassemble it, and hand it to the shared
 * decoder. Because hls.js fetches every segment via CORS-checked requests, "hls.js
 * can play it" is equivalent to "the segments are CORS-accessible, so we can read
 * them" — the same gate covers playback and extraction. A non-CORS / DRM / live
 * source simply fails to load, which surfaces as a clear error rather than a hang.
 *
 * For a plain (non-HLS) media URL we just fetch the bytes (CORS-permitting) and
 * decode them directly.
 *
 * hls.js is loaded lazily from a CDN the first time it is needed, so non-HLS
 * users pay nothing. Loaded as a plain <script> after audio-source.js (it calls
 * the global `decodeToMono16k`).
 *
 * Scope (v1): VOD only, sources hls.js can load, fully client-side. Live HLS,
 * DRM, and a server-side proxy for non-CORS hosts are out of scope.
 */

/* eslint-disable no-undef */

const HLS_CDN_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.mjs';
let hlsModulePromise = null;

// Lazy-load hls.js (ESM) once, returning the Hls constructor.
function loadHlsLibrary() {
  if (hlsModulePromise === null) {
    hlsModulePromise = import(HLS_CDN_URL).then((mod) => mod.default);
  }
  return hlsModulePromise;
}

// True for an HLS manifest URL (.m3u8, allowing a query string or fragment).
function isHlsUrl(url) {
  return /\.m3u8(\?|#|$)/i.test(String(url || '').trim());
}

// True if the bytes start with the HLS manifest signature (#EXTM3U), tolerating
// a leading BOM / whitespace.
function looksLikeM3u8(arrayBuffer) {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(arrayBuffer.slice(0, 16)));
  return head.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
}

// Decide whether a URL is HLS. Many sources serve a manifest from an API/xrpc
// endpoint with no .m3u8 extension (e.g. stream.place's getVideoPlaylist), so an
// extension check alone misses them — fall back to fetching and sniffing the
// content type / body. Returns { isHls, bytes, url } where `url` is the URL that
// actually worked (see the double-encoding recovery below) and `bytes` is the
// fetched body for a non-HLS URL (so the caller need not fetch it again).
async function classifyMediaUrl(url) {
  // A URL never contains literal whitespace; strip any that crept in from
  // copy/paste (e.g. a long URL that wrapped across lines) so it doesn't break
  // the request.
  url = String(url).replace(/\s+/g, '');

  if (isHlsUrl(url)) {
    return { isHls: true, bytes: null, url };
  }

  let workingUrl = url;
  let response = await fetch(url).catch(() => null);

  // Recover from a double-percent-encoded URL (e.g. an already-encoded link
  // re-copied through an address bar: %3A → %253A), which servers reject as a
  // 400. Collapsing one %25 level turns %253A back into %3A and leaves a
  // correctly single-encoded URL untouched. Retry once with that.
  if ((response === null || !response.ok) && /%25/i.test(url)) {
    const collapsed = url.replace(/%25/gi, '%');
    const retry = await fetch(collapsed).catch(() => null);
    if (retry !== null && retry.ok) {
      response = retry;
      workingUrl = collapsed;
    }
  }

  if (response === null || !response.ok) {
    throw new Error(`Could not fetch the media (HTTP ${response ? response.status : 'network / CORS error'}).`);
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const bytes = await response.arrayBuffer();
  const isHls = contentType.includes('mpegurl') || looksLikeM3u8(bytes);
  return { isHls, bytes, url: workingUrl };
}

// From a MASTER playlist that declares a separate audio rendition
// (#EXT-X-MEDIA:TYPE=AUDIO,...,URI="..."), return the absolute URL of that
// audio-only media playlist. This lets extraction skip a (possibly huge) video
// variant and download just the audio. Returns null for muxed streams (audio in
// the same segments as video) or a plain media playlist, where there is nothing
// to switch to.
function pickAudioRenditionUrl(manifestText, baseUrl) {
  const audioLines = String(manifestText).split(/\r?\n/).filter((line) =>
    /^#EXT-X-MEDIA:/i.test(line) && /TYPE=AUDIO/i.test(line) && /URI="/i.test(line)
  );
  if (audioLines.length === 0) return null;
  const chosen = audioLines.find((l) => /DEFAULT=YES/i.test(l)) || audioLines[0];
  const match = chosen.match(/URI="([^"]+)"/i);
  if (!match) return null;
  try {
    return new URL(match[1], baseUrl).href;
  } catch (e) {
    return null;
  }
}

// Tear down any hls.js instance previously attached to this media element.
function detachHls(videoEl) {
  if (videoEl && videoEl._hls) {
    try { videoEl._hls.destroy(); } catch (e) { /* already gone */ }
    videoEl._hls = null;
  }
}

/**
 * Attach the given URL to a media element for playback (click-to-seek after
 * transcription). HLS goes through hls.js where supported, native HLS on Safari,
 * and a plain URL is set directly. `isHls` may be passed when already known
 * (e.g. from readAudioFromUrl) to avoid a second sniff; otherwise it is detected.
 */
async function attachMediaPlayback(videoEl, url, isHls) {
  detachHls(videoEl);

  if (isHls === undefined) {
    try { isHls = (await classifyMediaUrl(url)).isHls; }
    catch (e) { isHls = isHlsUrl(url); }
  }

  if (!isHls) {
    videoEl.src = url;
    return;
  }

  const Hls = await loadHlsLibrary();
  if (Hls && Hls.isSupported()) {
    const hls = new Hls();
    videoEl._hls = hls;
    hls.loadSource(url);
    hls.attachMedia(videoEl);
  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = url; // Safari native HLS
  } else {
    throw new Error('HLS playback is not supported in this browser.');
  }
}

/**
 * Resolve a remote media URL to a 16 kHz mono Float32Array for the engines.
 * Classifies the URL once (HLS by extension, content type, or #EXTM3U body),
 * sets up playback on `videoEl` for click-to-seek (best-effort), and extracts:
 * HLS via the segment-tap extractor, a plain URL decoded from the bytes already
 * fetched while classifying (so it is not downloaded twice). `onProgress(percent)`
 * is called during HLS download when known.
 */
async function readAudioFromUrl(url, videoEl, onProgress) {
  const { isHls, bytes, url: workingUrl } = await classifyMediaUrl(url);

  if (videoEl) {
    // playback is secondary to transcription — don't fail the run if it can't attach
    try { await attachMediaPlayback(videoEl, workingUrl, isHls); } catch (e) { console.warn(e); }
  }

  return isHls ? readAudioFromHls(workingUrl, onProgress) : decodeToMono16k(bytes);
}


/* ---------------------------------------------------------------------------
 * HLS VOD audio extraction — direct byte-range segment fetch.
 *
 * We do NOT use hls.js's Media Source buffering here (its buffer/eviction model
 * stalls on these streams — bursting all segments trips rate limits, while
 * pacing via playback stalls near the end). Instead we parse the audio media
 * playlist ourselves and fetch the segments directly, with bounded concurrency
 * and retries, then concatenate init + segments into one fragmented-MP4 byte
 * stream and decode it. On stream.place the segments are byte ranges into a
 * single blob, so these are Range requests over one keep-alive connection —
 * throughput-bound, not latency-bound. (hls.js is still used for *playback* of
 * the visible player, see attachMediaPlayback.)
 * ------------------------------------------------------------------------- */

const HLS_FETCH_CONCURRENCY = 12;
const HLS_SEGMENT_RETRIES = 4;

function hlsSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTextResource(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Playlist fetch failed (HTTP ${response.status}).`);
  }
  return response.text();
}

// Parse a media playlist into { initSegment, segments }, resolving URLs against
// baseUrl and carrying #EXT-X-BYTERANGE (both on segments and #EXT-X-MAP). A
// byte range with no explicit offset continues from the previous range of the
// same resource (per the HLS spec) — tracked per-URL.
function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  let initSegment = null;
  const segments = [];
  let pendingRange = null;               // { length, offset|null }
  const prevEndByUrl = Object.create(null);

  const rangeFor = (url, range) => {
    let offset = range.offset;
    if (offset === null) offset = prevEndByUrl[url] || 0;
    prevEndByUrl[url] = offset + range.length;
    return { byteStart: offset, byteEnd: offset + range.length - 1 };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;

    if (/^#EXT-X-MAP:/i.test(line)) {
      const uriMatch = line.match(/URI="([^"]+)"/i);
      if (uriMatch) {
        const url = new URL(uriMatch[1], baseUrl).href;
        const seg = { url };
        const brMatch = line.match(/BYTERANGE="?(\d+)(?:@(\d+))?"?/i);
        if (brMatch) {
          const r = rangeFor(url, { length: +brMatch[1], offset: brMatch[2] !== undefined ? +brMatch[2] : null });
          seg.byteStart = r.byteStart;
          seg.byteEnd = r.byteEnd;
        }
        initSegment = seg;
      }
      continue;
    }

    if (/^#EXT-X-BYTERANGE:/i.test(line)) {
      const m = line.match(/^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/i);
      if (m) pendingRange = { length: +m[1], offset: m[2] !== undefined ? +m[2] : null };
      continue;
    }

    if (line.startsWith('#')) continue;  // EXTINF and other tags

    // a media segment URI
    const url = new URL(line, baseUrl).href;
    const seg = { url };
    if (pendingRange) {
      const r = rangeFor(url, pendingRange);
      seg.byteStart = r.byteStart;
      seg.byteEnd = r.byteEnd;
      pendingRange = null;
    }
    segments.push(seg);
  }

  return { initSegment, segments };
}

async function fetchSegmentBytes(seg) {
  const options = seg.byteStart !== undefined
    ? { headers: { Range: `bytes=${seg.byteStart}-${seg.byteEnd}` } }
    : undefined;
  let lastError = null;
  for (let attempt = 0; attempt < HLS_SEGMENT_RETRIES; attempt++) {
    try {
      const response = await fetch(seg.url, options);
      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (e) {
      lastError = e;
      await hlsSleep(300 * (attempt + 1)); // linear backoff
    }
  }
  throw new Error(`Segment fetch failed after ${HLS_SEGMENT_RETRIES} tries: ${lastError && lastError.message ? lastError.message : lastError}`);
}

/**
 * Extract audio from an HLS VOD and return a 16 kHz mono Float32Array.
 * Resolves to a separate audio rendition when present (skips video), parses the
 * media playlist, fetches init + segments directly with bounded concurrency and
 * retries, concatenates them, and decodes. `onProgress(percent)` reports the
 * segment download.
 */
async function readAudioFromHls(url, onProgress) {
  // Prefer an audio-only rendition (skip a possibly huge video variant).
  let playlistUrl = url;
  let playlistText = await fetchTextResource(url);
  const audioUrl = pickAudioRenditionUrl(playlistText, url);
  if (audioUrl) {
    playlistUrl = audioUrl;
    playlistText = await fetchTextResource(audioUrl);
  }

  const { initSegment, segments } = parseMediaPlaylist(playlistText, playlistUrl);
  if (segments.length === 0) {
    throw new Error('No audio segments were found in the stream.');
  }

  const base = initSegment ? 1 : 0;
  const parts = new Array(base + segments.length);
  if (initSegment) {
    parts[0] = await fetchSegmentBytes(initSegment);
  }

  // bounded-concurrency worker pool over the segment list, preserving order
  let nextIndex = 0;
  let completed = 0;
  const runWorker = async () => {
    for (;;) {
      const i = nextIndex++;
      if (i >= segments.length) return;
      parts[base + i] = await fetchSegmentBytes(segments[i]);
      completed += 1;
      if (typeof onProgress === 'function') {
        onProgress(Math.round((completed / segments.length) * 100));
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HLS_FETCH_CONCURRENCY, segments.length) }, runWorker)
  );

  let totalBytes = 0;
  for (const part of parts) totalBytes += part.byteLength;
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }

  return decodeFragmentedMp4ToMono16k(merged.buffer);
}

/* ---------------------------------------------------------------------------
 * Fragmented-MP4 audio decode.
 *
 * decodeAudioData cannot decode our concatenated init+segments: the init's mvhd
 * carries a bogus duration and the stream is fragmented (samples live in moof,
 * not a moov sample table), so decodeAudioData rejects it or reports the wrong
 * length. Instead we demux the AAC samples with mp4box.js and decode them with
 * the WebCodecs AudioDecoder — neither depends on mvhd — then resample the PCM
 * to 16 kHz mono. (This is the in-browser equivalent of the ffmpeg remux the
 * offline pipeline used.) If WebCodecs is unavailable we fall back to
 * decodeAudioData as a best effort.
 * ------------------------------------------------------------------------- */

const MP4BOX_CDN_URL = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js';
let mp4boxPromise = null;

function loadMp4Box() {
  if (mp4boxPromise === null) {
    mp4boxPromise = new Promise((resolve, reject) => {
      if (typeof window !== 'undefined' && window.MP4Box) {
        resolve(window.MP4Box);
        return;
      }
      const script = document.createElement('script');
      script.src = MP4BOX_CDN_URL;
      script.onload = () => {
        if (window.MP4Box) resolve(window.MP4Box);
        else reject(new Error('MP4Box did not load.'));
      };
      script.onerror = () => reject(new Error('Could not load the MP4Box library.'));
      document.head.appendChild(script);
    });
  }
  return mp4boxPromise;
}

// AAC-LC AudioSpecificConfig (the WebCodecs `description`) synthesised from the
// sample rate and channel count — robust, avoids fragile esds extraction.
const AAC_SAMPLE_RATE_INDEX = {
  96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
  24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11, 7350: 12,
};
function aacAudioSpecificConfig(sampleRate, channels) {
  const objectType = 2; // AAC-LC
  const freqIndex = AAC_SAMPLE_RATE_INDEX[sampleRate];
  if (freqIndex === undefined) return null;
  const b0 = (objectType << 3) | (freqIndex >> 1);
  const b1 = ((freqIndex & 1) << 7) | (channels << 3);
  return new Uint8Array([b0 & 0xff, b1 & 0xff]);
}

// Resample a mono Float32Array from `nativeRate` to 16 kHz using an
// OfflineAudioContext (reuses the browser's high-quality resampler).
async function resampleMonoTo16k(mono, nativeRate) {
  if (nativeRate === 16000) return mono;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const source = new AudioBuffer({ length: mono.length, sampleRate: nativeRate, numberOfChannels: 1 });
  source.copyToChannel(mono, 0);
  const outLength = Math.max(1, Math.ceil(mono.length * 16000 / nativeRate));
  const ctx = new OfflineCtx(1, outLength, 16000);
  const node = ctx.createBufferSource();
  node.buffer = source;
  node.connect(ctx.destination);
  node.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

async function decodeFragmentedMp4ToMono16k(arrayBuffer) {
  if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
    // No WebCodecs — best-effort fallback (may fail on fragmented MP4).
    return decodeToMono16k(arrayBuffer);
  }

  const MP4Box = await loadMp4Box();

  // 1. Demux: parse the fMP4 and collect the audio track's encoded samples.
  const { samples, sampleRate, channels, codec } = await new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    const collected = [];
    let track = null;

    file.onError = (e) => reject(new Error('MP4 demux error: ' + e));
    file.onReady = (info) => {
      track = (info.tracks || []).find((t) => t.type === 'audio') ||
              (info.audioTracks && info.audioTracks[0]);
      if (!track) { reject(new Error('No audio track found in the stream.')); return; }
      file.setExtractionOptions(track.id, null, { nbSamples: 100000 });
      file.start();
    };
    file.onSamples = (id, user, sampleList) => {
      for (const s of sampleList) collected.push(s);
    };

    // mp4box parses synchronously, so onReady + onSamples fire during these calls
    const buf = arrayBuffer;
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();

    if (!track) {
      reject(new Error('Could not read the audio track (MP4 moov not found).'));
      return;
    }
    resolve({
      samples: collected,
      sampleRate: track.audio.sample_rate,
      channels: track.audio.channel_count,
      codec: track.codec,
    });
  });

  if (!samples.length) throw new Error('No audio samples found in the stream.');

  // 2. Decode the AAC samples to PCM with WebCodecs.
  const pcmParts = [];
  let nativeRate = sampleRate;
  await new Promise((resolve, reject) => {
    const decoder = new AudioDecoder({
      output: (audioData) => {
        nativeRate = audioData.sampleRate;
        const frames = audioData.numberOfFrames;
        const mono = new Float32Array(frames);
        try {
          audioData.copyTo(mono, { planeIndex: 0, format: 'f32-planar' }); // channel 0
        } catch (e) {
          // some builds expose interleaved f32 only
          const inter = new Float32Array(frames * audioData.numberOfChannels);
          audioData.copyTo(inter, { planeIndex: 0, format: 'f32' });
          for (let i = 0; i < frames; i++) mono[i] = inter[i * audioData.numberOfChannels];
        }
        pcmParts.push(mono);
        audioData.close();
      },
      error: (e) => reject(e),
    });

    const description = aacAudioSpecificConfig(sampleRate, channels);
    const config = { codec: codec || 'mp4a.40.2', sampleRate, numberOfChannels: channels };
    if (description) config.description = description;
    decoder.configure(config);

    for (const s of samples) {
      const usToTicks = 1e6 / s.timescale;
      decoder.decode(new EncodedAudioChunk({
        type: 'key', // each AAC access unit is independently decodable
        timestamp: Math.round(s.cts * usToTicks),
        duration: Math.round(s.duration * usToTicks),
        data: s.data,
      }));
    }
    decoder.flush().then(resolve).catch(reject);
  });

  // 3. Concatenate and resample to 16 kHz mono.
  let total = 0;
  for (const part of pcmParts) total += part.length;
  const monoNative = new Float32Array(total);
  let off = 0;
  for (const part of pcmParts) { monoNative.set(part, off); off += part.length; }

  return resampleMonoTo16k(monoNative, nativeRate);
}

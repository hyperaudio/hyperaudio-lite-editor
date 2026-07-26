/**
 * stream-stretch.js
 * (C) The Hyperaudio Project
 * @version 0.8.6 — extracted from media-export.js in release 0.8.6
 * @license MIT
 *
 * Incremental pitch-preserved time-stretch for export (#405).
 *
 * media-export.js used to decode the WHOLE edited timeline into memory,
 * concatenate it, and hand one giant AudioBuffer to SoundTouch — three
 * full-timeline Float32 copies, multi-GB on long media. But SoundTouch's
 * SimpleFilter is a pull pipeline: it fetches input through
 * extract(target, numFrames, position) with a monotonically advancing
 * position, so nothing requires the whole timeline to exist at once.
 *
 * makeChunkedSource() is that pull-source, backed by a sliding window of
 * decoded chunks: buffers are pushed as they decode, and chunks the filter
 * has read past are dropped, so peak memory is seconds of PCM. It serves
 * interleaved stereo (mono duplicated), like SoundTouch's own
 * WebAudioBufferSource.
 *
 * makeStreamStretcher() drives a SimpleFilter over that source: push()
 * decoded AudioBuffers as they arrive and stretched blocks are emitted (as
 * AudioBuffers) as soon as SoundTouch produces them; flush() drains the
 * pipeline after the last push. Output is sample-identical to the old
 * whole-timeline path (unit-tested), including its behaviour of dropping
 * the sub-window tail SoundTouch never processes.
 *
 * Dependency-injected: pass the loaded soundtouchjs module namespace as
 * `st` (media-export.js lazy-loads the vendored copy). Uses the global
 * AudioBuffer constructor.
 */

'use strict';

const makeChunkedSource = () => {
  const chunks = [];  // interleaved-stereo Float32Arrays, contiguous
  let baseFrame = 0;  // absolute frame index of the start of chunks[0]
  let endFrame = 0;   // absolute frame index just past the last pushed frame
  return {
    push(buffer) {
      const frames = buffer.length;
      const L = buffer.getChannelData(0);
      const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
      const data = new Float32Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        data[i * 2] = L[i];
        data[i * 2 + 1] = R[i];
      }
      chunks.push(data);
      endFrame += frames;
    },
    extract(target, numFrames, position) {
      while (chunks.length > 0 && baseFrame + chunks[0].length / 2 <= position) {
        baseFrame += chunks[0].length / 2;
        chunks.shift();
      }
      const n = Math.min(numFrames, Math.max(0, endFrame - position));
      let written = 0;
      let chunkStart = baseFrame;
      for (const c of chunks) {
        if (written >= n) break;
        const cFrames = c.length / 2;
        const from = position + written - chunkStart;
        if (from < cFrames) {
          const count = Math.min(cFrames - from, n - written);
          target.set(c.subarray(from * 2, (from + count) * 2), written * 2);
          written += count;
        }
        chunkStart += cFrames;
      }
      return written;
    },
    // window occupancy in frames — exposed for tests/diagnostics
    windowFrames() {
      let frames = 0;
      for (const c of chunks) frames += c.length / 2;
      return frames;
    },
  };
};

const makeStreamStretcher = (st, rate, emit) => {
  const shifter = new st.SoundTouch();
  shifter.tempo = rate;
  const feed = makeChunkedSource();
  const filter = new st.SimpleFilter(feed, shifter);
  const FRAMES = 8192;
  const tmp = new Float32Array(FRAMES * 2); // SoundTouch works in stereo interleaved
  let sampleRate = 0;
  let channels = 2;
  const drain = async (final) => {
    let n;
    while ((n = filter.extract(tmp, FRAMES)) > 0) {
      const out = new AudioBuffer({ length: n, numberOfChannels: channels, sampleRate });
      const L = out.getChannelData(0);
      const R = channels > 1 ? out.getChannelData(1) : null;
      for (let i = 0; i < n; i++) {
        L[i] = tmp[i * 2];
        if (R) R[i] = tmp[i * 2 + 1];
      }
      await emit(out);
      if (!final && n < FRAMES) break; // source starved — wait for more input
    }
  };
  return {
    async push(buffer) {
      if (sampleRate === 0) {
        sampleRate = buffer.sampleRate;
        channels = Math.min(2, buffer.numberOfChannels);
      }
      feed.push(buffer);
      await drain(false);
    },
    async flush() {
      await drain(true);
    },
    // exposed for tests/diagnostics
    windowFrames: () => feed.windowFrames(),
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    makeChunkedSource,
    makeStreamStretcher
  };
}

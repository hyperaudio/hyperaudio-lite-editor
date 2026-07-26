// Unit tests for stream-stretch.js (#405): the incremental time-stretch must be
// sample-identical to the whole-timeline path it replaced (decode everything,
// concatAudioBuffers, one SoundTouch pass), while holding only a sliding window
// of source PCM. The old path is reimplemented here verbatim as the reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeChunkedSource, makeStreamStretcher } = require('../../js/stream-stretch.js');
const st = await import('../../js/vendor/soundtouchjs-0.3.0.js');

// Minimal AudioBuffer stand-in (Node has none); stream-stretch.js and the
// reference path only use the constructor + getChannelData/copyToChannel.
class FakeAudioBuffer {
  constructor({ length, numberOfChannels, sampleRate }) {
    this.length = length;
    this.numberOfChannels = numberOfChannels;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._ch = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(c) { return this._ch[c]; }
  copyToChannel(src, c, offset = 0) { this._ch[c].set(src, offset); }
}
globalThis.AudioBuffer = FakeAudioBuffer;

const SR = 44100;

const mkChunk = (frames, seed, channels = 2) => {
  const b = new FakeAudioBuffer({ length: frames, numberOfChannels: channels, sampleRate: SR });
  let x = seed;
  for (let i = 0; i < frames; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff; // deterministic noise
    b.getChannelData(0)[i] = Math.sin(i / 20) * 0.5 + (x / 0x7fffffff - 0.5) * 0.1;
    if (channels > 1) b.getChannelData(1)[i] = Math.cos(i / 17) * 0.5 - (x / 0x7fffffff - 0.5) * 0.1;
  }
  return b;
};

// The pre-#405 whole-timeline path, verbatim (concat + one-shot SoundTouch).
const concatAudioBuffers = (buffers) => {
  if (buffers.length === 1) return buffers[0];
  const channels = Math.max(...buffers.map((b) => b.numberOfChannels));
  const sampleRate = buffers[0].sampleRate;
  const length = buffers.reduce((sum, b) => sum + b.length, 0);
  const out = new FakeAudioBuffer({ length, numberOfChannels: channels, sampleRate });
  let offset = 0;
  for (const b of buffers) {
    for (let c = 0; c < channels; c++) {
      out.copyToChannel(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), c, offset);
    }
    offset += b.length;
  }
  return out;
};

const timeStretchWholeTimeline = (buffer, rate) => {
  const shifter = new st.SoundTouch();
  shifter.tempo = rate;
  const filter = new st.SimpleFilter(new st.WebAudioBufferSource(buffer), shifter);
  const FRAMES = 8192;
  const tmp = new Float32Array(FRAMES * 2);
  const parts = [];
  let n;
  while ((n = filter.extract(tmp, FRAMES)) > 0) parts.push(tmp.slice(0, n * 2));
  let total = 0;
  for (const p of parts) total += p.length / 2;
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  let i = 0;
  for (const p of parts) {
    for (let j = 0; j < p.length; j += 2) { L[i] = p[j]; R[i] = p[j + 1]; i++; }
  }
  return { L, R, frames: total };
};

const streamStretch = async (chunks, rate) => {
  const got = [];
  const stretcher = makeStreamStretcher(st, rate, async (b) => got.push(b));
  let peak = 0;
  for (const c of chunks) {
    await stretcher.push(c);
    peak = Math.max(peak, stretcher.windowFrames());
  }
  await stretcher.flush();
  const frames = got.reduce((s, b) => s + b.length, 0);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  let o = 0;
  for (const b of got) {
    L.set(b.getChannelData(0), o);
    R.set(b.getChannelData(b.numberOfChannels > 1 ? 1 : 0), o);
    o += b.length;
  }
  return { L, R, frames, peak };
};

// awkward chunk sizes on purpose (decoders typically hand back ~1024–4096)
const SIZES = [30000, 12345, 7777, 1024, 65536, 3, 44100];

for (const rate of [1.25, 0.8, 2.0]) {
  test(`streamed output is sample-identical to the whole-timeline path at ${rate}×`, async () => {
    const chunks = SIZES.map((s, i) => mkChunk(s, i + 1));
    const ref = timeStretchWholeTimeline(concatAudioBuffers(chunks), rate);
    const got = await streamStretch(chunks, rate);
    assert.equal(got.frames, ref.frames);
    assert.deepEqual(got.L, ref.L);
    assert.deepEqual(got.R, ref.R);
  });
}

test('source window stays bounded instead of accumulating the timeline', async () => {
  const chunks = SIZES.map((s, i) => mkChunk(s, i + 1));
  const totalFrames = SIZES.reduce((a, b) => a + b, 0);
  const { peak } = await streamStretch(chunks, 1.25);
  // window is bounded by consumption lag + the largest single chunk,
  // never the accumulated timeline
  assert.ok(peak < totalFrames / 2, `peak window ${peak} vs timeline ${totalFrames}`);
});

test('mono input: duplicated to stereo for SoundTouch, like WebAudioBufferSource', async () => {
  const chunks = [mkChunk(20000, 1, 1), mkChunk(15000, 2, 1)];
  const ref = timeStretchWholeTimeline(concatAudioBuffers(chunks), 1.5);
  const got = await streamStretch(chunks, 1.5);
  assert.equal(got.frames, ref.frames);
  assert.deepEqual(got.L, ref.L);
});

test('makeChunkedSource serves across chunk boundaries and drops read-past chunks', () => {
  const feed = makeChunkedSource();
  feed.push(mkChunk(100, 1));
  feed.push(mkChunk(50, 2));
  feed.push(mkChunk(75, 3));
  const out = new Float32Array(140 * 2);
  assert.equal(feed.extract(out, 140, 60), 140);       // spans all three chunks
  assert.equal(feed.windowFrames(), 225);              // nothing dropped yet (60 < 100)
  assert.equal(feed.extract(out, 10, 160), 10);        // past chunks 1+2
  assert.equal(feed.windowFrames(), 75);               // first two chunks dropped
  assert.equal(feed.extract(out, 50, 225), 0);         // beyond pushed data
});

// #627 — the audio a URL yields comes back as a mono 16 kHz WAV from
// mediabunny and is read without an AudioContext, so the file is never held
// twice. The header walk is pure, and these pin it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pcmFromWav } = require('../../js/audio-source.js');

// A RIFF/WAVE file with the given samples, 16-bit PCM unless `float`.
function makeWav(samples, { sampleRate = 16000, channels = 1, float = false, extraChunk = false } = {}) {
  const bytesPerSample = float ? 4 : 2;
  const dataBytes = samples.length * bytesPerSample;
  const fact = extraChunk ? 12 : 0;              // an unknown chunk before `data`
  const buffer = new ArrayBuffer(44 + fact + dataBytes);
  const view = new DataView(buffer);
  const tag = (offset, s) => { for (let i = 0; i < 4; i += 1) view.setUint8(offset + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, 36 + fact + dataBytes, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, float ? 3 : 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  let at = 36;
  if (extraChunk) { tag(at, 'LIST'); view.setUint32(at + 4, 4, true); at += 12; }
  tag(at, 'data'); view.setUint32(at + 4, dataBytes, true);
  at += 8;
  samples.forEach((s, i) => {
    if (float) view.setFloat32(at + i * 4, s, true);
    else view.setInt16(at + i * 2, Math.round(s * 32768), true);
  });
  return buffer;
}

test('16-bit PCM is scaled to -1..1 (#627)', () => {
  const { samples, sampleRate, channels } = pcmFromWav(makeWav([0, 0.5, -0.5]));
  assert.equal(sampleRate, 16000);
  assert.equal(channels, 1);
  assert.equal(samples.length, 3);
  assert.equal(samples[0], 0);
  assert.ok(Math.abs(samples[1] - 0.5) < 1e-4);
  assert.ok(Math.abs(samples[2] + 0.5) < 1e-4);
});

test('32-bit float samples come through unchanged (#627)', () => {
  const { samples } = pcmFromWav(makeWav([0.25, -0.75], { float: true }));
  assert.ok(Math.abs(samples[0] - 0.25) < 1e-6);
  assert.ok(Math.abs(samples[1] + 0.75) < 1e-6);
});

test('chunks before `data` are walked, not assumed away (#627)', () => {
  const { samples } = pcmFromWav(makeWav([0.5, 0.5], { extraChunk: true }));
  assert.equal(samples.length, 2);
  assert.ok(Math.abs(samples[0] - 0.5) < 1e-4);
});

test('a data chunk declaring more than it holds yields what is there (#627)', () => {
  // a streamed WAV can leave the length unset or optimistic
  const wav = makeWav([0.5, 0.5]);
  new DataView(wav).setUint32(40, 0xffff, true);
  assert.equal(pcmFromWav(wav).samples.length, 2);
});

test('the rate and channel count are reported, so a mismatch can be caught (#627)', () => {
  const { sampleRate, channels, samples } = pcmFromWav(makeWav([0, 0, 0, 0], { sampleRate: 48000, channels: 2 }));
  assert.equal(sampleRate, 48000);
  assert.equal(channels, 2);
  assert.equal(samples.length, 2);   // frames, not samples: channel 0 of each
});

test('rubbish is refused rather than read as silence (#627)', () => {
  assert.throws(() => pcmFromWav(new ArrayBuffer(8)), /Not a WAV/);
  const noData = makeWav([0.5]).slice(0, 36);
  assert.throws(() => pcmFromWav(noData), /no data chunk|Not a WAV/);
});

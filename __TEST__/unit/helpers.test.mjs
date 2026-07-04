// Unit lane smoke test — also validates the e2e suite's measuring instrument:
// the WAV builder/analyser used by export-cuts.spec.mjs must be trustworthy for
// its verdicts to mean anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ladderWav, analyseWav } from '../e2e/helpers.mjs';

test('ladderWav/analyseWav round-trip: duration and tone timeline', () => {
  const { duration, sampleRate, freqs } = analyseWav(ladderWav(3));
  assert.equal(sampleRate, 44100);
  assert.ok(Math.abs(duration - 3) < 0.001);
  assert.deepEqual(freqs, [200, 200, 300, 300, 400, 400]);
});

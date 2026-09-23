// #676 — a percentage that moves within each transcription window, from the
// facts a worker reports. Pure, so every path is exercised here with a clock
// of our own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createProgressTracker } = createRequire(import.meta.url)('../../js/transcription-progress.js');

test('a single window shows a percentage, and it rises through both stages to 100', () => {
  const t = createProgressTracker({ device: 'webgpu' });
  assert.equal(t.percent(0), 0);
  t.on({ window: 0, windows: 1, stage: 'encode', seconds: 300 }, 1000);
  // 300 s at 40x: 7.5 s expected for the encoder, which owns half the bar by default
  assert.equal(t.percent(1000), 0);
  assert.equal(t.percent(1000 + 3750), 25);
  // a slow encoder counts up to its stage's end and holds there; it does not overshoot
  assert.equal(t.percent(1000 + 7500), 50);
  assert.equal(t.percent(1000 + 60000), 50);
  t.on({ stage: 'decode', frames: 3750, frame: 0, encoderMs: 7000 }, 9000);
  assert.equal(t.percent(9000), 50);
  t.on({ stage: 'decode', frame: 1875 }, 12000);
  assert.equal(t.percent(12000), 75);
  t.on({ stage: 'decode', frame: 3750 }, 15000);
  assert.equal(t.percent(15000), 100);
  t.on({ stage: 'done', decodeMs: 7000 }, 15000);
  assert.equal(t.percent(15000), 100);
});

test('the encoder\'s share is learned from the first window, so later windows are right on the CPU too', () => {
  const t = createProgressTracker({ device: 'wasm' });
  t.on({ window: 0, windows: 4, stage: 'encode', seconds: 300 }, 0);
  t.on({ stage: 'decode', frames: 3750, frame: 0, encoderMs: 90000 }, 90000);   // encoder 90 s
  t.on({ stage: 'done', decodeMs: 10000 }, 100000);                              // decoder 10 s: share 0.9
  assert.equal(t.inspect().share, 0.9);
  // second window: elapsed time against the MEASURED 90 s, not the default rate
  t.on({ window: 1, windows: 4, stage: 'encode', seconds: 300 }, 100000);
  assert.equal(t.percent(100000 + 45000), Math.floor(((1 + 0.9 * 0.5) / 4) * 100));   // 36
  t.on({ stage: 'decode', frames: 3750, frame: 0, encoderMs: 90000 }, 190000);
  assert.equal(t.percent(190000), Math.floor(((1 + 0.9) / 4) * 100));                 // 47
});

test('the percentage never falls', () => {
  const t = createProgressTracker({ device: 'webgpu' });
  t.on({ window: 0, windows: 2, stage: 'encode', seconds: 300 }, 0);
  const high = t.percent(7000);
  t.on({ stage: 'decode', frames: 100, frame: 0, encoderMs: 2000 }, 7000);        // encoder was quicker than expected
  assert.ok(t.percent(7000) >= high);
  let last = 0;
  for (let f = 0; f <= 100; f += 10) { t.on({ stage: 'decode', frame: f }, 8000 + f); const p = t.percent(8000 + f); assert.ok(p >= last); last = p; }
  t.on({ stage: 'done', decodeMs: 1000 }, 9000);
  t.on({ window: 1, windows: 2, stage: 'encode', seconds: 300 }, 9000);
  assert.ok(t.percent(9000) >= last);
  assert.equal(t.percent(9000), 50);
});

test('an unknown device and missing facts are tolerated', () => {
  const t = createProgressTracker({});
  t.on(null); t.on({ stage: 'decode', frame: 5 });
  assert.equal(t.percent(), 0);
  t.on({ window: 0, windows: 3, stage: 'encode' }, 0);
  assert.equal(t.percent(5000), 0);   // no seconds: nothing to extrapolate against
  t.on({ stage: 'done' }, 6000);
  assert.equal(t.percent(6000), 33);
});

// The run behind the report: 9:58 of audio, three windows of 300, 300 and
// 18 s, on a GPU that does Whisper Base at 12x. The first window counts up
// slowly against the default guess and jumps to its step when the window
// ends; from then on each window is paced by the one before, per second of
// audio, so the short tail does not crawl.
test('an engine whose window is one opaque call counts up slowly, holds at the step, and is then paced by the last window', () => {
  const t = createProgressTracker({ device: 'webgpu' });
  t.on({ window: 0, windows: 3, stage: 'run', seconds: 300 }, 0);   // 75 s expected at the default 4x
  assert.equal(t.percent(0), 0);
  assert.equal(t.percent(24000), 10);                                // the window actually took 24 s...
  t.on({ stage: 'done', runMs: 24000 }, 24000);
  assert.equal(t.percent(24000), 33);                                // ...so it jumps to the step
  t.on({ window: 1, windows: 3, stage: 'run', seconds: 300 }, 24000);
  assert.equal(t.percent(24000 + 12000), 50);                        // paced by the 24 s just measured
  assert.equal(t.percent(24000 + 24000), 66);
  assert.equal(t.percent(24000 + 40000), 66);                        // a slower window holds at the step
  t.on({ stage: 'done', runMs: 23500 }, 47500);
  t.on({ window: 2, windows: 3, stage: 'run', seconds: 18 }, 47500); // 1.4 s expected, not 24
  assert.equal(t.percent(47500 + 700), 83);
  t.on({ stage: 'done', runMs: 600 }, 48100);
  assert.equal(t.percent(48100), 100);
});

test('a short last window is paced by its own length on the Parakeet path too', () => {
  const p = createProgressTracker({ device: 'webgpu' });
  p.on({ window: 0, windows: 2, stage: 'encode', seconds: 300 }, 0);
  p.on({ stage: 'decode', frames: 3750, frame: 0, encoderMs: 30000 }, 30000);   // 100 ms per second
  p.on({ stage: 'done', decodeMs: 30000 }, 60000);
  p.on({ window: 1, windows: 2, stage: 'encode', seconds: 30 }, 60000);         // 3 s expected
  assert.equal(p.percent(60000 + 1500), Math.floor(((1 + 0.5 * 0.5) / 2) * 100));   // 62
});

test('a fresh tracker seeded from a previous run starts at zero but keeps its measurements', () => {
  const first = createProgressTracker({ device: 'webgpu' });
  first.on({ window: 0, windows: 1, stage: 'run', seconds: 300 }, 0);
  first.on({ stage: 'done', runMs: 40000 }, 40000);
  assert.equal(first.percent(40000), 100);
  const second = createProgressTracker({ device: 'webgpu', seed: first.inspect() });
  assert.equal(second.percent(50000), 0);
  second.on({ window: 0, windows: 1, stage: 'run', seconds: 300 }, 50000);
  assert.equal(second.percent(50000 + 20000), 50);   // paced by the first run's 40 s
});

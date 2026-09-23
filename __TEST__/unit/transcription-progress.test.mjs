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
  // 300 s at 40x: ~7.5 s expected for the encoder, which owns half the bar by default
  assert.equal(t.percent(1000), 0);
  const mid = t.percent(1000 + 3750);
  assert.ok(mid > 20 && mid < 30, `half way through the expected encoder time: ${mid}`);
  // the extrapolation is capped: a slow encoder holds, it does not overshoot the stage
  assert.equal(t.percent(1000 + 60000), Math.floor(0.5 * 0.95 * 100));
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
  t.on({ window: 0, windows: 1, stage: 'encode' }, 0);
  assert.equal(t.percent(1000), 0);                       // no seconds: nothing to extrapolate from
  t.on({ stage: 'decode', frames: 0 }, 1000);
  assert.equal(t.percent(1000), 50);                      // no frames: the stage's start
});

test('an engine whose window is one opaque call is extrapolated by elapsed time, capped, and snaps at done', () => {
  const t = createProgressTracker({ device: 'webgpu' });
  t.on({ window: 0, windows: 2, stage: 'run', seconds: 300 }, 0);
  // 300 s at the default 8x: 37.5 s expected for the window, which is half the bar
  assert.equal(t.percent(0), 0);
  const quarter = t.percent(37500 / 2);
  assert.ok(quarter >= 24 && quarter <= 25, `half way through the expected time: ${quarter}`);
  assert.equal(t.percent(600000), Math.floor(0.95 * 50));   // a slow window holds at the cap
  t.on({ stage: 'done', runMs: 60000 }, 60000);
  assert.equal(t.percent(60000), 50);
  // the second window is paced by what the first one took, not the default
  t.on({ window: 1, windows: 2, stage: 'run', seconds: 300 }, 60000);
  assert.equal(t.percent(60000 + 30000), 75);
  t.on({ stage: 'done', runMs: 58000 }, 120000);
  assert.equal(t.percent(120000), 100);
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

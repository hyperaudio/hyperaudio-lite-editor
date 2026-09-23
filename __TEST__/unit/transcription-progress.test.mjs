// #676 — a percentage that moves within each transcription window, from the
// facts a worker reports. Pure, so every path is exercised here with a clock
// of our own. `target` is what the facts say; `percent` is what is shown,
// which trails it a point at a time (last test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createProgressTracker } = createRequire(import.meta.url)('../../js/transcription-progress.js');

test('a single window shows a percentage, and it rises through both stages to 100', () => {
  const t = createProgressTracker({ device: 'webgpu' });
  assert.equal(t.target(0), 0);
  t.on({ window: 0, windows: 1, stage: 'encode', seconds: 300 }, 1000);
  // 300 s at 40x: 7.5 s expected for the encoder, which owns half the bar by default
  assert.equal(t.target(1000), 0);
  assert.equal(t.target(1000 + 3750), 25);
  // a slow encoder counts up to its stage's end and holds there; it does not overshoot
  assert.equal(t.target(1000 + 7500), 50);
  assert.equal(t.target(1000 + 60000), 50);
  t.on({ stage: 'decode', frames: 3750, frame: 0, encoderMs: 7000 }, 9000);
  assert.equal(t.target(9000), 50);
  t.on({ stage: 'decode', frame: 1875 }, 12000);
  assert.equal(t.target(12000), 75);
  t.on({ stage: 'decode', frame: 3750 }, 15000);
  assert.equal(t.target(15000), 100);
  t.on({ stage: 'done', decodeMs: 7000 }, 15000);
  assert.equal(t.target(15000), 100);
});

test('the encoder\'s share is learned from the first window, so later windows are right on the CPU too', () => {
  const t = createProgressTracker({ device: 'wasm' });
  t.on({ window: 0, windows: 4, stage: 'encode', seconds: 300 }, 0);
  t.on({ stage: 'decode', frames: 3750, frame: 0, encoderMs: 90000 }, 90000);   // encoder 90 s
  t.on({ stage: 'done', decodeMs: 10000 }, 100000);                              // decoder 10 s: share 0.9
  assert.equal(t.inspect().share, 0.9);
  // second window: elapsed time against the MEASURED 90 s (plus the 20% margin), not the default rate
  t.on({ window: 1, windows: 4, stage: 'encode', seconds: 300 }, 100000);
  assert.equal(t.target(100000 + 54000), Math.floor(((1 + 0.9 * 0.5) / 4) * 100));   // 36
  t.on({ stage: 'decode', frames: 3750, frame: 0, encoderMs: 90000 }, 190000);
  assert.equal(t.target(190000), Math.floor(((1 + 0.9) / 4) * 100));                 // 47
});

test('the percentage never falls', () => {
  const t = createProgressTracker({ device: 'webgpu' });
  t.on({ window: 0, windows: 2, stage: 'encode', seconds: 300 }, 0);
  const high = t.target(7000);
  t.on({ stage: 'decode', frames: 100, frame: 0, encoderMs: 2000 }, 7000);        // encoder was quicker than expected
  assert.ok(t.target(7000) >= high);
  let last = 0;
  for (let f = 0; f <= 100; f += 10) { t.on({ stage: 'decode', frame: f }, 8000 + f); const p = t.target(8000 + f); assert.ok(p >= last); last = p; }
  t.on({ stage: 'done', decodeMs: 1000 }, 9000);
  t.on({ window: 1, windows: 2, stage: 'encode', seconds: 300 }, 9000);
  assert.ok(t.target(9000) >= last);
  assert.equal(t.target(9000), 50);
});

test('an unknown device and missing facts are tolerated', () => {
  const t = createProgressTracker({});
  t.on(null); t.on({ stage: 'decode', frame: 5 });
  assert.equal(t.target(), 0);
  t.on({ window: 0, windows: 3, stage: 'encode' }, 0);
  assert.equal(t.target(5000), 0);   // no seconds: nothing to extrapolate against
  t.on({ stage: 'done' }, 6000);
  assert.equal(t.target(6000), 33);
});

// The run behind the report: 9:58 of audio, three windows of 300, 300 and
// 18 s, on a GPU that does Whisper Base at 12x. The first window counts up
// slowly against the default guess and jumps to its step when the window
// ends; from then on each window is paced by the one before, per second of
// audio and with a 20% margin, so the short tail does not crawl and a window
// a little slower than the last does not wait at the step.
test('an engine whose window is one opaque call counts up slowly, holds at the step, and is then paced by the last window', () => {
  const t = createProgressTracker({ device: 'webgpu' });
  t.on({ window: 0, windows: 3, stage: 'run', seconds: 300 }, 0);   // 75 s expected at the default 4x
  assert.equal(t.target(0), 0);
  assert.equal(t.target(24000), 10);                                // the window actually took 24 s...
  t.on({ stage: 'done', runMs: 24000 }, 24000);
  assert.equal(t.target(24000), 33);                                // ...so it jumps to the step
  t.on({ window: 1, windows: 3, stage: 'run', seconds: 300 }, 24000);
  assert.equal(t.target(24000 + 14400), 50);                        // paced by the 24 s just measured, plus the margin: 28.8 s
  assert.equal(t.target(24000 + 24000), 61);
  assert.equal(t.target(24000 + 40000), 66);                        // a slower window holds at the step
  t.on({ stage: 'done', runMs: 23500 }, 47500);
  t.on({ window: 2, windows: 3, stage: 'run', seconds: 18 }, 47500); // 1.7 s expected, not 24
  assert.equal(t.target(47500 + 846), 83);
  t.on({ stage: 'done', runMs: 600 }, 48100);
  assert.equal(t.target(48100), 100);
});

test('a short last window is paced by its own length on the Parakeet path too', () => {
  const p = createProgressTracker({ device: 'webgpu' });
  p.on({ window: 0, windows: 2, stage: 'encode', seconds: 300 }, 0);
  p.on({ stage: 'decode', frames: 3750, frame: 0, encoderMs: 30000 }, 30000);   // 100 ms per second
  p.on({ stage: 'done', decodeMs: 30000 }, 60000);
  p.on({ window: 1, windows: 2, stage: 'encode', seconds: 30 }, 60000);         // 3 s expected, 3.6 with the margin
  assert.equal(p.target(60000 + 1800), Math.floor(((1 + 0.5 * 0.5) / 2) * 100));   // 62
});

test('every run counts the same way: a fresh tracker starts from the guess, not the last run', () => {
  const first = createProgressTracker({ device: 'webgpu' });
  first.on({ window: 0, windows: 1, stage: 'run', seconds: 300 }, 0);
  first.on({ stage: 'done', runMs: 24000 }, 24000);
  assert.equal(first.target(24000), 100);
  const second = createProgressTracker({ device: 'webgpu' });
  second.on({ window: 0, windows: 1, stage: 'run', seconds: 300 }, 50000);
  assert.equal(second.target(50000 + 24000), 32);   // 24 of 75 s, as the first run showed at that point
});

// The shown value never leaps: when the first window finished at 10% of the
// slow guess, the display counted 10, 11, 12 … 33 rather than jumping, and
// if the next window moved the target on meanwhile it simply kept counting.
test('what is shown counts up to a target that leapt, one point per tenth of a second', () => {
  const t = createProgressTracker({ device: 'webgpu' });
  t.on({ window: 0, windows: 3, stage: 'run', seconds: 300 }, 0);
  assert.equal(t.percent(0), 0);
  assert.equal(t.percent(24000), 10);
  t.on({ stage: 'done', runMs: 24000 }, 24000);
  t.on({ window: 1, windows: 3, stage: 'run', seconds: 300 }, 24000);
  assert.equal(t.target(24000), 33);
  const seen = [];
  for (let ms = 24000; ms <= 24000 + 3000; ms += 100) seen.push(t.percent(ms));
  assert.deepEqual(seen.slice(0, 5), [10, 11, 12, 13, 14]);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] - seen[i - 1] <= 1, `a step of one: ${seen}`);
  // by then the second window has moved the target past 33, and the count went on to it
  assert.equal(seen[seen.length - 1], t.target(27000));
  assert.ok(seen[seen.length - 1] > 33);
  // sitting at the target banks no credit: the next leap is still counted to
  for (let ms = 27000; ms <= 30000; ms += 100) t.percent(ms);
  t.on({ stage: 'done', runMs: 24000 }, 30000);
  t.on({ window: 2, windows: 3, stage: 'run', seconds: 18 }, 30000);
  t.on({ stage: 'done', runMs: 600 }, 30600);
  assert.equal(t.target(30600), 100);
  const atEnd = t.percent(30600);
  assert.ok(atEnd < 100, `${atEnd}`);
  assert.equal(t.percent(30700), atEnd + 1);
});

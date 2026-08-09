import test from 'node:test';
import assert from 'node:assert/strict';
import maintenance from '../../js/transcript-maintenance.js';

const { createTranscriptMaintenanceQueue } = maintenance;

function fakeClock() {
  let serial = 0;
  const tasks = new Map();
  return {
    setTimer(fn) {
      const id = ++serial;
      tasks.set(id, fn);
      return id;
    },
    clearTimer(id) { tasks.delete(id); },
    fire() {
      const pending = [...tasks.values()];
      tasks.clear();
      pending.forEach((fn) => fn());
    },
    size: () => tasks.size,
  };
}

test('many dirty signals collapse into one pending run', () => {
  const clock = fakeClock();
  const reasons = [];
  const queue = createTranscriptMaintenanceQueue({
    run: (reason) => reasons.push(reason),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  queue.markDirty('input-1');
  queue.markDirty('input-2');
  queue.schedule('keyup');
  assert.equal(clock.size(), 1);

  clock.fire();
  assert.deepEqual(reasons, ['keyup']);
  assert.equal(queue.inspect().dirty, false);
  assert.equal(queue.inspect().runCount, 1);
});

test('a barrier flushes immediately and cancels the delayed duplicate', () => {
  const clock = fakeClock();
  const reasons = [];
  const queue = createTranscriptMaintenanceQueue({
    run: (reason) => reasons.push(reason),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  queue.markDirty('input');
  assert.equal(queue.flush('blur'), true);
  assert.equal(clock.size(), 0);
  clock.fire();
  assert.deepEqual(reasons, ['blur']);
});

test('a closed gate retains dirty work until it can run', () => {
  const clock = fakeClock();
  let allowed = false;
  let runs = 0;
  const queue = createTranscriptMaintenanceQueue({
    run: () => { runs += 1; },
    canRun: () => allowed,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  assert.equal(queue.markDirty('caption-mode'), false);
  assert.equal(queue.inspect().dirty, true);
  allowed = true;
  assert.equal(queue.schedule('transcript-mode'), true);
  clock.fire();
  assert.equal(runs, 1);
  assert.equal(queue.inspect().dirty, false);
});

test('destroy makes a superseded queue inert', () => {
  const clock = fakeClock();
  let runs = 0;
  const queue = createTranscriptMaintenanceQueue({
    run: () => { runs += 1; },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  queue.markDirty('old-document');
  queue.destroy();
  clock.fire();
  assert.equal(runs, 0);
  assert.equal(queue.inspect().destroyed, true);
  assert.equal(queue.markDirty('late'), false);
});

test('cancel drops pending work but leaves the queue reusable', () => {
  const clock = fakeClock();
  let runs = 0;
  const queue = createTranscriptMaintenanceQueue({
    run: () => { runs += 1; },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  queue.markDirty('superseded');
  assert.equal(queue.cancel(), true);
  clock.fire();
  assert.equal(runs, 0);
  assert.equal(queue.inspect().dirty, false);

  queue.markDirty('new-work');
  clock.fire();
  assert.equal(runs, 1);
});

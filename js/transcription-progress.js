/**
 * transcription-progress.js
 * (C) The Hyperaudio Project
 * @version 1.3.23 — last changed in release 1.3.23
 * @license MIT
 *
 * A percentage for a local transcription that moves within each window
 * (#676), from the facts a worker can report:
 *
 *   window i of n has started          -> { window, windows, stage: 'encode', seconds }
 *   its encoder has finished           -> { stage: 'decode', frames, encoderMs }
 *   its decoder is at frame f of frames-> { stage: 'decode', frame }
 *   the window is done                 -> { stage: 'done', decodeMs }
 *
 * or, for an engine whose window is one opaque call (Whisper):
 *
 *   window i of n has started          -> { window, windows, stage: 'run', seconds }
 *   the window is done                 -> { stage: 'done', runMs }
 *
 * The decoder walks frames one at a time, so its share of a window is measured.
 * The encoder is one opaque call, so it is counted up by elapsed time: towards
 * the stage's end over the time the previous window's encoder took per second
 * of audio, or, before one has finished, over a deliberately slow guess for
 * the device. Reaching the end early and holding there is fine, and so is
 * jumping to it when the window finishes sooner — what is not fine is running
 * past it. How the two stages divide a window is learned from the first window
 * rather than assumed, which is what makes the CPU path, where the encoder is
 * the bulk, come out right. The percentage never falls.
 *
 * A whole opaque window is counted up the same way, against the time the
 * previous window took per second of audio (so a short last window is paced
 * by its own length).
 *
 * What is shown trails what is known: when the target leaps (a window that
 * finished sooner than the guess), the percentage counts up to it a point at
 * a time, every CATCH_UP_MS, so every number in between is seen.
 *
 * A tracker is for one transcription: it never falls, so a second run needs
 * a fresh one, and a fresh one starts from the guess again, so every run
 * counts the same way.
 *
 * Pure: no DOM, no timers of its own. Exported for node tests.
 */
(function () {
  // seconds of audio an encoder gets through per second, before anything has
  // been measured: one 300 s window took ~7 s on an M4 Pro's GPU (#309), and
  // the CPU path runs at about 2.7x realtime end to end (#325), the encoder
  // being most of that
  const ENCODER_RATE = { webgpu: 40, wasm: 3 };
  // seconds of audio a whole opaque window gets through per second, before
  // anything has been measured: deliberately slow. Whisper Base on an Apple
  // GPU measured 12x (#676); a guess that is too slow only means a jump
  // forward when the window ends, while one that is too fast overshoots.
  const WINDOW_RATE = { webgpu: 4, wasm: 1 };
  const DEFAULT_SHARE = 0.5;      // the encoder's share of a window, until measured
  // a measured window is expected to take this much longer next time: paced
  // to the exact measurement, any run slightly slower reaches the step early
  // and waits there, while erring slow leaves a little for the catch-up
  const MARGIN = 1.2;
  const CATCH_UP_MS = 100;        // one point per this, when the shown value is behind the target

  // 0..1 for elapsed against expected: a straight count that holds at the end
  function countUp(elapsedMs, expectedMs) {
    return expectedMs > 0 ? Math.min(1, elapsedMs / expectedMs) : 0;
  }

  function createProgressTracker(options) {
    const opts = options || {};
    const rate = ENCODER_RATE[opts.device] || ENCODER_RATE.wasm;
    const windowRate = WINDOW_RATE[opts.device] || WINDOW_RATE.wasm;
    let windows = 0;
    let index = -1;              // which window
    let stage = 'idle';
    let stageStart = 0;
    let seconds = 0;              // the current window's audio
    let frames = 0;
    let frame = 0;
    let share = DEFAULT_SHARE;    // encoder's share of a window
    // the last measured ms per second of audio, so a short window is paced by
    // its length
    let encoderMsPerSecond = null;
    let runMsPerSecond = null;
    let encoderMs = null;         // this window's, once reported
    let best = 0;                 // the target: never falls
    let shown = 0;                // trails the target a point at a time
    let shownAt = null;           // when `shown` last earned a point

    function on(detail, now) {
      const at = typeof now === 'number' ? now : Date.now();
      if (!detail) return;
      if (detail.stage === 'encode' || detail.stage === 'run') {
        windows = detail.windows || windows;
        index = detail.window;
        seconds = detail.seconds || seconds;
        frames = 0; frame = 0;
        stage = detail.stage;
        stageStart = at;
      } else if (detail.stage === 'decode') {
        if (typeof detail.encoderMs === 'number') {
          encoderMs = detail.encoderMs;
          if (seconds > 0) encoderMsPerSecond = encoderMs / seconds;
        }
        if (typeof detail.frames === 'number') frames = detail.frames;
        if (typeof detail.frame === 'number') frame = detail.frame;
        if (stage !== 'decode') { stage = 'decode'; stageStart = at; }
      } else if (detail.stage === 'done') {
        if (typeof encoderMs === 'number' && typeof detail.decodeMs === 'number' && encoderMs + detail.decodeMs > 0) {
          share = encoderMs / (encoderMs + detail.decodeMs);
        }
        if (typeof detail.runMs === 'number' && detail.runMs > 0 && seconds > 0) runMsPerSecond = detail.runMs / seconds;
        stage = 'done';
      }
    }

    // 0..100, for the moment `now`: the target, approached a point per CATCH_UP_MS
    function percent(now) {
      const at = typeof now === 'number' ? now : Date.now();
      const target = targetPercent(at);
      if (shownAt === null || target <= shown) { shownAt = at; return shown; }   // nothing owed: no credit banked
      const points = Math.min(target - shown, Math.floor((at - shownAt) / CATCH_UP_MS));
      shown += points;
      shownAt = shown === target ? at : shownAt + points * CATCH_UP_MS;   // caught up: no credit banked
      return shown;
    }

    function targetPercent(at) {
      if (windows <= 0 || index < 0) return best;
      let fraction;
      if (stage === 'done') {
        fraction = 1;
      } else if (stage === 'decode') {
        fraction = share + (1 - share) * (frames > 0 ? Math.min(1, frame / frames) : 0);
      } else if (stage === 'run') {
        const expectedMs = runMsPerSecond !== null ? runMsPerSecond * seconds * MARGIN : (seconds / windowRate) * 1000;
        fraction = countUp(Math.max(0, at - stageStart), expectedMs);
      } else {
        const expectedMs = encoderMsPerSecond !== null ? encoderMsPerSecond * seconds * MARGIN : (seconds / rate) * 1000;
        fraction = share * countUp(Math.max(0, at - stageStart), expectedMs);
      }
      const value = Math.floor(((index + fraction) / windows) * 100);
      best = Math.max(best, Math.min(100, value));
      return best;
    }

    return {
      on, percent,
      target: (now) => targetPercent(typeof now === 'number' ? now : Date.now()),
      inspect: () => ({ windows, window: index, stage, seconds, share, encoderMsPerSecond, runMsPerSecond, frames, frame, target: best, shown }),
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createProgressTracker };
  if (typeof window !== 'undefined') window.createTranscriptionProgressTracker = createProgressTracker;
})();

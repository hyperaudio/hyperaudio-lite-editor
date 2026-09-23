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
 * The encoder is one opaque call, so its share is extrapolated by elapsed time
 * against how long the previous window's encoder took per second of audio —
 * and, before there is one, against a rate for the device. The extrapolation
 * runs straight to most of the stage over the expected time, then creeps
 * towards a cap it never reaches: a slower stage than expected keeps moving,
 * it does not stall, and it does not overshoot either. How the two stages
 * divide a window is learned from the first window rather than assumed, which
 * is what makes the CPU path, where the encoder is the bulk, come out right.
 * The percentage never falls.
 *
 * A whole opaque window is treated like the encoder: extrapolated against the
 * fastest window so far per second of audio (so a short last window is paced
 * by its own length), snapping to its end when the window reports done. The
 * fastest, not the latest: a window is only ever slower than steady state
 * because of one-off costs — the first window of a Whisper run pays for
 * shader compilation at the real chunk size — and pacing the next window by
 * that leaves the bar creeping and then leaping.
 *
 * A tracker is for one transcription: it never falls, so a second run needs
 * a fresh one. `seed` takes a previous tracker's inspect() so what that run
 * measured (encoder time, share, window time) carries over.
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
  // anything has been measured: deliberately on the slow side, since a rate
  // that is too fast runs out of straight line early and creeps for the rest
  // of the window, while one that is too slow only means a jump forward when
  // the window ends. 8x looked stuck on a three-window Whisper file (#676).
  const WINDOW_RATE = { webgpu: 4, wasm: 1 };
  const LINEAR_TO = 0.8;          // an extrapolated stage gets this far over its expected time...
  const CAP = 0.95;               // ...then creeps towards this, never reaching it
  const DEFAULT_SHARE = 0.5;      // the encoder's share of a window, until measured

  // 0..CAP for elapsed against expected: straight to LINEAR_TO, then an
  // exponential approach to CAP with the expected time as its constant
  function extrapolate(elapsedMs, expectedMs) {
    if (!(expectedMs > 0)) return 0;
    const x = elapsedMs / expectedMs;
    if (x <= 1) return LINEAR_TO * x;
    return LINEAR_TO + (CAP - LINEAR_TO) * (1 - Math.exp(-(x - 1)));
  }

  function createProgressTracker(options) {
    const opts = options || {};
    const rate = ENCODER_RATE[opts.device] || ENCODER_RATE.wasm;
    const windowRate = WINDOW_RATE[opts.device] || WINDOW_RATE.wasm;
    const seed = opts.seed || {};
    let windows = 0;
    let index = -1;              // which window
    let stage = 'idle';
    let stageStart = 0;
    let seconds = 0;              // the current window's audio
    let frames = 0;
    let frame = 0;
    let share = typeof seed.share === 'number' ? seed.share : DEFAULT_SHARE;    // encoder's share of a window
    // the fastest measured ms per second of audio, so a short window is paced
    // by its length and a one-off slow window does not pace the ones after it
    let encoderMsPerSecond = typeof seed.encoderMsPerSecond === 'number' ? seed.encoderMsPerSecond : null;
    let runMsPerSecond = typeof seed.runMsPerSecond === 'number' ? seed.runMsPerSecond : null;
    const fastest = (sofar, ms) => (sofar === null ? ms : Math.min(sofar, ms));
    let encoderMs = null;         // this window's, once reported
    let best = 0;

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
          if (seconds > 0) encoderMsPerSecond = fastest(encoderMsPerSecond, encoderMs / seconds);
        }
        if (typeof detail.frames === 'number') frames = detail.frames;
        if (typeof detail.frame === 'number') frame = detail.frame;
        if (stage !== 'decode') { stage = 'decode'; stageStart = at; }
      } else if (detail.stage === 'done') {
        if (typeof encoderMs === 'number' && typeof detail.decodeMs === 'number' && encoderMs + detail.decodeMs > 0) {
          share = encoderMs / (encoderMs + detail.decodeMs);
        }
        if (typeof detail.runMs === 'number' && detail.runMs > 0 && seconds > 0) runMsPerSecond = fastest(runMsPerSecond, detail.runMs / seconds);
        stage = 'done';
      }
    }

    // 0..100, for the moment `now`
    function percent(now) {
      const at = typeof now === 'number' ? now : Date.now();
      if (windows <= 0 || index < 0) return best;
      let fraction;
      if (stage === 'done') {
        fraction = 1;
      } else if (stage === 'decode') {
        fraction = share + (1 - share) * (frames > 0 ? Math.min(1, frame / frames) : 0);
      } else if (stage === 'run') {
        const expectedMs = runMsPerSecond !== null ? runMsPerSecond * seconds : (seconds / windowRate) * 1000;
        fraction = extrapolate(Math.max(0, at - stageStart), expectedMs);
      } else {
        const expectedMs = encoderMsPerSecond !== null ? encoderMsPerSecond * seconds : (seconds / rate) * 1000;
        fraction = share * extrapolate(Math.max(0, at - stageStart), expectedMs);
      }
      const value = Math.floor(((index + fraction) / windows) * 100);
      best = Math.max(best, Math.min(100, value));
      return best;
    }

    return {
      on, percent,
      inspect: () => ({ windows, window: index, stage, seconds, share, encoderMsPerSecond, runMsPerSecond, frames, frame }),
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createProgressTracker };
  if (typeof window !== 'undefined') window.createTranscriptionProgressTracker = createProgressTracker;
})();

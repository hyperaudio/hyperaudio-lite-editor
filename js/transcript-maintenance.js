/* Collapsed maintenance queue for expensive transcript-wide derived work. */

(function (root) {
  'use strict';

  function createTranscriptMaintenanceQueue(options) {
    const opts = options || {};
    if (typeof opts.run !== 'function') {
      throw new TypeError('createTranscriptMaintenanceQueue expects a run function');
    }

    const delay = Number.isFinite(opts.delay) ? Math.max(0, opts.delay) : 1000;
    const canRun = typeof opts.canRun === 'function' ? opts.canRun : () => true;
    const setTimer = opts.setTimer || setTimeout;
    const clearTimer = opts.clearTimer || clearTimeout;
    let timer = null;
    let dirty = false;
    let running = false;
    let destroyed = false;
    let scheduledCount = 0;
    let runCount = 0;
    let lastReason = null;

    function cancelTimer() {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    }

    function schedule(reason) {
      if (destroyed || !dirty) return false;
      cancelTimer();
      lastReason = reason || lastReason || 'scheduled';
      if (!canRun()) return false;
      scheduledCount += 1;
      timer = setTimer(() => {
        timer = null;
        flush(lastReason || 'scheduled');
      }, delay);
      return true;
    }

    function markDirty(reason) {
      if (destroyed) return false;
      dirty = true;
      return schedule(reason || 'dirty');
    }

    function flush(reason, flushOptions) {
      const force = !!(flushOptions && flushOptions.force);
      if (destroyed || running || (!dirty && !force)) return false;
      cancelTimer();
      if (!canRun()) {
        dirty = true;
        return false;
      }

      dirty = false;
      running = true;
      lastReason = reason || lastReason || 'flush';
      try {
        opts.run(lastReason);
        runCount += 1;
      } catch (error) {
        dirty = true;
        throw error;
      } finally {
        running = false;
        if (dirty) schedule('reentrant');
      }
      return true;
    }

    function destroy() {
      cancelTimer();
      dirty = false;
      destroyed = true;
    }

    function cancel() {
      if (destroyed) return false;
      const hadWork = dirty || timer !== null;
      cancelTimer();
      dirty = false;
      return hadWork;
    }

    return Object.freeze({
      markDirty,
      schedule,
      flush,
      cancel,
      destroy,
      inspect: () => Object.freeze({
        dirty,
        pending: timer !== null,
        running,
        destroyed,
        scheduledCount,
        runCount,
        lastReason,
      }),
    });
  }

  if (root) root.createTranscriptMaintenanceQueue = createTranscriptMaintenanceQueue;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createTranscriptMaintenanceQueue };
  }
})(typeof window !== 'undefined' ? window : globalThis);

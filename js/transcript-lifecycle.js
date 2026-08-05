/* Transcript lifecycle contract for same-document restores and identity changes. */

(function () {
  'use strict';

  const IDENTITY_EVENT = 'hyperaudioDocumentIdentityChanged';
  const RESTORED_EVENT = 'hyperaudioTranscriptRestored';
  const MAX_AUDIT_ENTRIES = 50;
  let generation = 0;
  const audit = [];

  function liveTimedTranscript() {
    const transcript = document.getElementById('hypertranscript');
    return transcript !== null && transcript.querySelector('span[data-m]') !== null
      ? transcript : null;
  }

  function record(type, detail) {
    audit.push({ type, detail, at: Date.now() });
    if (audit.length > MAX_AUDIT_ENTRIES) audit.shift();
  }

  function signalIdentity(origin, extra) {
    if (liveTimedTranscript() === null) {
      console.warn('transcript-lifecycle: ignored identity signal without a timed transcript');
      return false;
    }
    generation += 1;
    const detail = Object.freeze(Object.assign({}, extra || {}, {
      generation,
      origin: origin || 'unknown',
    }));
    record('identity', detail);
    document.dispatchEvent(new CustomEvent(IDENTITY_EVENT, { detail }));
    return true;
  }

  function signalRestored(origin, extra) {
    if (liveTimedTranscript() === null) {
      console.warn('transcript-lifecycle: ignored restore signal without a timed transcript');
      return false;
    }
    const detail = Object.freeze(Object.assign({}, extra || {}, {
      generation,
      origin: origin || 'unknown',
    }));
    record('restore', detail);
    document.dispatchEvent(new CustomEvent(RESTORED_EVENT, { detail }));
    return true;
  }

  window.transcriptLifecycle = Object.freeze({
    IDENTITY_EVENT,
    RESTORED_EVENT,
    signalIdentity,
    signalRestored,
    generation: () => generation,
    // Read-only copy for diagnostics and lifecycle regression tests.
    auditLog: () => audit.map((entry) => ({
      type: entry.type,
      detail: Object.assign({}, entry.detail),
      at: entry.at,
    })),
  });
})();

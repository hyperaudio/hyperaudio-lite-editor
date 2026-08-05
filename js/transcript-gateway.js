/* Single transaction door for programmatic transcript document mutations. */

(function () {
  'use strict';

  let mutationDepth = 0;
  let restoreDepth = 0;
  let transactionId = 0;
  let currentTransaction = null;
  const beforeListeners = new Set();
  const afterListeners = new Set();

  let auditObserver = null;
  let auditRoot = null;
  let nativeInputType = null;
  const auditEntries = [];

  function transcriptFromEvent(event) {
    const target = event && event.target;
    return target && target.closest && target.closest('#hypertranscript');
  }

  function describeRecord(record) {
    const target = record.target.nodeType === Node.ELEMENT_NODE
      ? record.target : record.target.parentElement;
    return {
      type: record.type,
      attributeName: record.attributeName || null,
      target: target ? target.tagName.toLowerCase()
        + (target.id ? `#${target.id}` : '')
        + (target.className && typeof target.className === 'string'
          ? `.${target.className.trim().replace(/\s+/g, '.')}` : '') : null,
    };
  }

  function isSearchViewMutation(record) {
    if (record.type === 'attributes') {
      return record.target.nodeType === Node.ELEMENT_NODE
        && (record.target.matches('mark.search-mark, .search-match')
          || (record.attributeName === 'class'
            && /(?:^|\s)search-match(?:\s|$)/.test(record.oldValue || '')));
    }
    if (record.target.nodeType === Node.ELEMENT_NODE
        && record.target.matches('.search-match')) return true;
    const nodes = Array.from(record.addedNodes).concat(Array.from(record.removedNodes));
    return nodes.some((node) => node.nodeType === Node.ELEMENT_NODE
      && (node.matches('mark.search-mark') || node.querySelector('mark.search-mark')));
  }

  function isSpeakerVisibilityMutation(record) {
    if (record.type !== 'attributes'
      || record.attributeName !== 'style'
      || record.target.nodeType !== Node.ELEMENT_NODE
      || !record.target.matches('span.speaker')) return false;
    const before = record.oldValue || '';
    const after = record.target.getAttribute('style') || '';
    return !/text-decoration/i.test(before + after);
  }

  function recordAudit(records, classification, origin) {
    records.forEach((record) => {
      let kind = classification;
      let recordOrigin = origin;
      if (kind === 'unclassified' && isSearchViewMutation(record)) {
        kind = 'view';
        recordOrigin = 'search';
      } else if (kind === 'unclassified' && isSpeakerVisibilityMutation(record)) {
        kind = 'view';
        recordOrigin = 'speaker-visibility';
      }
      auditEntries.push(Object.freeze({
        classification: kind,
        origin: recordOrigin || 'unknown',
        record: Object.freeze(describeRecord(record)),
      }));
    });
  }

  function claimAuditRecords(classification, origin) {
    if (auditObserver === null) return;
    const records = auditObserver.takeRecords();
    if (records.length > 0) recordAudit(records, classification, origin);
  }

  function notify(listeners, transaction) {
    listeners.forEach((listener) => {
      try {
        listener(transaction);
      } catch (error) {
        console.error('transcript-gateway: transaction listener failed', error);
      }
    });
  }

  function mutate(fn, options) {
    if (typeof fn !== 'function') throw new TypeError('transcriptGateway.mutate expects a function');
    const opts = options || {};
    if (restoreDepth > 0) return fn();

    if (mutationDepth > 0) {
      mutationDepth += 1;
      try {
        return fn();
      } finally {
        mutationDepth -= 1;
      }
    }

    const transaction = Object.freeze({
      id: ++transactionId,
      origin: opts.origin || 'unknown',
      foldPolicy: opts.foldPolicy || null,
    });
    currentTransaction = transaction;
    mutationDepth = 1;
    notify(beforeListeners, transaction);
    let result;
    let error = null;
    try {
      result = fn();
      return result;
    } catch (caught) {
      error = caught;
      throw caught;
    } finally {
      claimAuditRecords('gateway', transaction.origin);
      mutationDepth = 0;
      currentTransaction = null;
      notify(afterListeners, Object.freeze({
        id: transaction.id,
        origin: transaction.origin,
        foldPolicy: transaction.foldPolicy,
        error,
      }));
    }
  }

  function restoring(fn) {
    if (typeof fn !== 'function') throw new TypeError('transcriptGateway.restoring expects a function');
    restoreDepth += 1;
    try {
      return fn();
    } finally {
      claimAuditRecords('restore', 'history');
      restoreDepth -= 1;
    }
  }

  function subscribe(listeners, callback) {
    if (typeof callback !== 'function') throw new TypeError('transcriptGateway listener must be a function');
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  const audit = Object.freeze({
    start(root) {
      if (auditObserver !== null) auditObserver.disconnect();
      auditEntries.length = 0;
      auditRoot = root || document.getElementById('hypertranscript');
      if (auditRoot === null || typeof MutationObserver === 'undefined') return false;
      auditObserver = new MutationObserver((records) => {
        recordAudit(records, 'unclassified', null);
      });
      auditObserver.observe(auditRoot, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
      });
      return true;
    },
    stop() {
      if (auditObserver !== null) {
        claimAuditRecords('unclassified', null);
        auditObserver.disconnect();
      }
      auditObserver = null;
      auditRoot = null;
      nativeInputType = null;
      return auditEntries.slice();
    },
    entries: () => auditEntries.slice(),
    violations: () => auditEntries.filter((entry) => entry.classification === 'unclassified'),
    clear: () => { auditEntries.length = 0; },
  });

  // Native edits mutate between beforeinput and input. Take their records in
  // the input handler before MutationObserver delivers them as apparent bypasses.
  document.addEventListener('beforeinput', (event) => {
    if (transcriptFromEvent(event)) nativeInputType = event.inputType || 'native-input';
  }, true);
  document.addEventListener('input', (event) => {
    if (!transcriptFromEvent(event)) return;
    if (mutationDepth > 0 || restoreDepth > 0) return;
    claimAuditRecords('native', nativeInputType || event.inputType || 'native-input');
    nativeInputType = null;
  }, true);

  window.transcriptGateway = Object.freeze({
    mutate,
    restoring,
    get isMutating() { return mutationDepth > 0; },
    get isRestoring() { return restoreDepth > 0; },
    get currentTransaction() { return currentTransaction; },
    onBeforeMutate: (callback) => subscribe(beforeListeners, callback),
    onAfterMutate: (callback) => subscribe(afterListeners, callback),
    audit,
  });
})();

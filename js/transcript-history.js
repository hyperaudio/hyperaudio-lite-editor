/* Bounded snapshot undo/redo for the live transcript DOM (#400). */

(function () {
  'use strict';

  const MAX_ENTRIES = 100;
  const MAX_BYTES = 12 * 1024 * 1024;
  const COALESCE_MS = 500;
  const gateway = window.transcriptGateway;
  let entries = [];
  let position = -1;
  let totalBytes = 0;
  let gatewayBefore = null;
  let pendingNative = null;
  let lastNative = null;
  let composing = false;
  let compositionBefore = null;
  let compositionTimer = null;
  let shortcutToken = null;
  let shortcutSerial = 0;

  function transcript() {
    return document.getElementById('hypertranscript');
  }

  function validTranscript() {
    const root = transcript();
    return root && root.querySelector('span[data-m]') ? root : null;
  }

  function captionMode() {
    const button = document.getElementById('caption-editor-btn');
    return button !== null && button.getAttribute('aria-pressed') === 'true';
  }

  function inTranscript(node) {
    return !!(node && node.closest && node.closest('#hypertranscript'));
  }

  function cleanClone(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('mark.search-mark').forEach((mark) => mark.replaceWith(...mark.childNodes));
    clone.querySelectorAll('.search-match').forEach((node) => node.classList.remove('search-match'));
    clone.querySelectorAll('.active').forEach((node) => node.classList.remove('active'));
    clone.querySelectorAll('span.speaker[style]').forEach((speaker) => {
      const struck = speaker.style.textDecoration.includes('line-through');
      speaker.removeAttribute('style');
      if (struck) speaker.style.textDecoration = 'line-through';
    });
    clone.normalize();
    return clone;
  }

  function semanticFingerprint(root) {
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.parentElement && node.parentElement.matches('span[data-m]')
          ? node.nodeValue : node.nodeValue.replace(/\s+/g, ' ').trim();
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName.toLowerCase();
      const children = Array.from(node.childNodes).map(visit).join('');
      if (tag === 'span' && node.hasAttribute('data-m')) {
        return `[w m=${JSON.stringify(node.getAttribute('data-m'))}`
          + ` d=${JSON.stringify(node.getAttribute('data-d'))}`
          + ` s=${node.classList.contains('speaker') ? 1 : 0}`
          + ` x=${node.style.textDecoration.includes('line-through') ? 1 : 0}]${children}[/w]`;
      }
      if (tag === 'article' || tag === 'section' || tag === 'p') {
        return `[${tag}]${children}[/${tag}]`;
      }
      return children;
    }
    return Array.from(root.childNodes).map(visit).join('');
  }

  function pointOffset(root, node, offset) {
    if (!node || !root.contains(node)) return null;
    const range = document.createRange();
    range.selectNodeContents(root);
    try {
      range.setEnd(node, offset);
      return range.toString().length;
    } catch (error) {
      return null;
    }
  }

  function captureSelection(root) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0
        || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
    const anchor = pointOffset(root, selection.anchorNode, selection.anchorOffset);
    const focus = pointOffset(root, selection.focusNode, selection.focusOffset);
    if (anchor === null || focus === null) return null;
    let backward = false;
    if (anchor !== focus) {
      const range = document.createRange();
      try {
        range.setStart(selection.anchorNode, selection.anchorOffset);
        range.setEnd(selection.focusNode, selection.focusOffset);
        backward = range.collapsed;
      } catch (error) { backward = anchor > focus; }
    }
    return { anchor, focus, backward };
  }

  function locateOffset(root, wanted) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = Math.max(0, wanted || 0);
    let last = root;
    while (walker.nextNode()) {
      last = walker.currentNode;
      const length = last.nodeValue.length;
      if (remaining <= length) return { node: last, offset: remaining };
      remaining -= length;
    }
    return last === root
      ? { node: root, offset: root.childNodes.length }
      : { node: last, offset: last.nodeValue.length };
  }

  function restoreSelection(root, saved, focus) {
    if (!saved) {
      if (focus) root.focus({ preventScroll: true });
      return;
    }
    const anchor = locateOffset(root, saved.anchor);
    const end = locateOffset(root, saved.focus);
    const selection = window.getSelection();
    if (focus) root.focus({ preventScroll: true });
    selection.removeAllRanges();
    if (typeof selection.setBaseAndExtent === 'function') {
      selection.setBaseAndExtent(anchor.node, anchor.offset, end.node, end.offset);
      return;
    }
    const range = document.createRange();
    const first = saved.backward ? end : anchor;
    const last = saved.backward ? anchor : end;
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    selection.addRange(range);
  }

  function snapshot(origin) {
    const root = validTranscript();
    if (!root) return null;
    const clone = cleanClone(root);
    const html = clone.innerHTML;
    const fingerprint = semanticFingerprint(clone);
    return Object.freeze({
      html,
      semanticFingerprint: fingerprint,
      selection: captureSelection(root),
      origin: origin || 'unknown',
      timestamp: Date.now(),
      bytes: (html.length + fingerprint.length) * 2,
    });
  }

  function sameSelection(a, b) {
    if (a === null || b === null) return a === b;
    return a.anchor === b.anchor && a.focus === b.focus && a.backward === b.backward;
  }

  function updateControls() {
    const disabled = captionMode() || validTranscript() === null;
    const undoButton = document.getElementById('transcript-undo');
    const redoButton = document.getElementById('transcript-redo');
    if (undoButton) undoButton.disabled = disabled || position <= 0;
    if (redoButton) redoButton.disabled = disabled || position < 0 || position >= entries.length - 1;
  }

  function prune() {
    while (entries.length > 1 && (entries.length > MAX_ENTRIES || totalBytes > MAX_BYTES)) {
      totalBytes -= entries[0].bytes;
      entries.shift();
      position -= 1;
    }
  }

  function replaceCurrent(next) {
    if (position < 0) return;
    totalBytes += next.bytes - entries[position].bytes;
    entries[position] = next;
    prune();
    updateControls();
  }

  function rememberPreEditSelection(before) {
    if (before && position >= 0
        && entries[position].semanticFingerprint === before.semanticFingerprint
        && !sameSelection(entries[position].selection, before.selection)) {
      replaceCurrent(before);
    }
  }

  function push(next) {
    if (!next) return false;
    const current = entries[position];
    if (current && current.semanticFingerprint === next.semanticFingerprint) {
      // Selection is useful even when the document did not change.
      replaceCurrent(next);
      return false;
    }
    if (position < entries.length - 1) {
      entries.slice(position + 1).forEach((entry) => { totalBytes -= entry.bytes; });
      entries.length = position + 1;
    }
    entries.push(next);
    totalBytes += next.bytes;
    position = entries.length - 1;
    prune();
    updateControls();
    return true;
  }

  function clearPending() {
    pendingNative = null;
    lastNative = null;
    compositionBefore = null;
    clearTimeout(compositionTimer);
    compositionTimer = null;
  }

  function reset(origin) {
    clearPending();
    entries = [];
    position = -1;
    totalBytes = 0;
    const baseline = snapshot(origin || 'identity');
    if (baseline) {
      entries.push(baseline);
      totalBytes = baseline.bytes;
      position = 0;
    }
    updateControls();
  }

  function inputCategory(inputType) {
    if (/^insert(?:Text|ReplacementText)$/.test(inputType)) return 'insert';
    if (/^deleteContent(?:Backward|Forward)$/.test(inputType)) return 'delete';
    return inputType || 'native';
  }

  function boundaryInput(inputType) {
    return !/^insert(?:Text|ReplacementText)$/.test(inputType)
      && !/^deleteContent(?:Backward|Forward)$/.test(inputType);
  }

  function commitNative(before, inputType, origin) {
    const after = snapshot(origin || inputType);
    if (!after || !before || before.semanticFingerprint === after.semanticFingerprint) return;
    const category = inputCategory(inputType);
    const now = Date.now();
    const coalesce = !boundaryInput(inputType) && lastNative
      && lastNative.category === category
      && now - lastNative.at <= COALESCE_MS
      && lastNative.generation === (window.transcriptLifecycle
        ? window.transcriptLifecycle.generation() : 0)
      && sameSelection(lastNative.selection, before.selection)
      && position === entries.length - 1;
    if (coalesce) replaceCurrent(after);
    else push(after);
    lastNative = {
      category,
      at: now,
      selection: after.selection,
      generation: window.transcriptLifecycle ? window.transcriptLifecycle.generation() : 0,
    };
  }

  function restore(direction, options) {
    if (composing || captionMode() || validTranscript() === null) return false;
    clearPending();
    const nextPosition = position + direction;
    if (nextPosition < 0 || nextPosition >= entries.length) return false;
    const target = entries[nextPosition];
    const root = transcript();
    const origin = direction < 0 ? 'undo' : 'redo';
    gateway.restoring(() => {
      root.innerHTML = target.html;
      restoreSelection(root, target.selection, !!(options && options.focus));
      root.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: origin === 'undo' ? 'historyUndo' : 'historyRedo',
      }));
      if (window.transcriptLifecycle) window.transcriptLifecycle.signalRestored(origin);
    });
    position = nextPosition;
    updateControls();
    if (typeof window.hyperaudioNormalizeAfterHistoryRestore === 'function') {
      window.hyperaudioNormalizeAfterHistoryRestore();
    }
    return true;
  }

  function performShortcut(action, focus) {
    shortcutToken = null;
    return action === 'undo' ? restore(-1, { focus }) : restore(1, { focus });
  }

  function cancelShortcut(execute) {
    const token = shortcutToken;
    if (!token) return;
    clearTimeout(token.timer);
    shortcutToken = null;
    if (execute) performShortcut(token.action, false);
  }

  function shortcutAction(event) {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
    const key = event.key.toLowerCase();
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'redo';
    return null;
  }

  gateway.onBeforeMutate((transaction) => {
    clearPending();
    gatewayBefore = snapshot(`before-${transaction.origin}`);
    rememberPreEditSelection(gatewayBefore);
  });

  gateway.onAfterMutate((transaction) => {
    const before = gatewayBefore;
    gatewayBefore = null;
    const after = snapshot(transaction.origin);
    if (!after || !before || before.semanticFingerprint === after.semanticFingerprint) {
      updateControls();
      return;
    }
    if (transaction.foldPolicy === 'normalization' && position >= 0
        && entries[position].semanticFingerprint === before.semanticFingerprint) {
      replaceCurrent(after); // deliberately preserves redo
    } else {
      push(after);
    }
  });

  document.addEventListener('beforeinput', (event) => {
    if (!inTranscript(event.target) || captionMode()) return;
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      if (event.isComposing || composing) return;
      event.preventDefault();
      const action = event.inputType === 'historyUndo' ? 'undo' : 'redo';
      if (shortcutToken && shortcutToken.action === action) {
        clearTimeout(shortcutToken.timer);
        shortcutToken = null;
      }
      performShortcut(action, false);
      return;
    }
    if (gateway.isRestoring || gateway.isMutating || composing || event.isComposing) return;
    pendingNative = { before: snapshot(`before-${event.inputType}`), inputType: event.inputType || 'native' };
    rememberPreEditSelection(pendingNative.before);
    if (boundaryInput(pendingNative.inputType)) lastNative = null;
  }, true);

  document.addEventListener('input', (event) => {
    if (!inTranscript(event.target) || gateway.isRestoring || gateway.isMutating || captionMode()) return;
    if (composing || event.isComposing) return;
    if (compositionBefore) {
      clearTimeout(compositionTimer);
      compositionTimer = null;
      const before = compositionBefore;
      compositionBefore = null;
      commitNative(before, 'insertCompositionText', 'composition');
      lastNative = null;
      return;
    }
    const pending = pendingNative;
    pendingNative = null;
    commitNative(pending ? pending.before : entries[position],
      pending ? pending.inputType : (event.inputType || 'native'), event.inputType || 'native');
  }, true);

  document.addEventListener('compositionstart', (event) => {
    if (!inTranscript(event.target) || captionMode()) return;
    composing = true;
    clearPending();
    compositionBefore = snapshot('before-composition');
    rememberPreEditSelection(compositionBefore);
  }, true);

  document.addEventListener('compositionend', (event) => {
    if (!inTranscript(event.target)) return;
    composing = false;
    // WebKit may emit the final input before or after compositionend.
    clearTimeout(compositionTimer);
    compositionTimer = setTimeout(() => {
      if (!compositionBefore) return;
      const before = compositionBefore;
      compositionBefore = null;
      commitNative(before, 'insertCompositionText', 'composition');
      lastNative = null;
    }, 0);
  }, true);

  document.addEventListener('keydown', (event) => {
    const action = shortcutAction(event);
    if (!action || event.isComposing || composing || captionMode() || !inTranscript(event.target)) return;
    event.preventDefault();
    cancelShortcut(false);
    const id = ++shortcutSerial;
    shortcutToken = {
      id,
      action,
      timer: setTimeout(() => {
        if (shortcutToken && shortcutToken.id === id) performShortcut(action, false);
      }, 0),
    };
  }, true);

  document.addEventListener('keyup', (event) => {
    if (shortcutAction(event)) cancelShortcut(true);
  }, true);
  window.addEventListener('blur', () => cancelShortcut(true));

  document.addEventListener('focusout', (event) => {
    if (inTranscript(event.target)) lastNative = null;
  }, true);

  document.addEventListener('hyperaudioDocumentIdentityChanged', (event) => {
    reset(event.detail && event.detail.origin);
  });
  // Contract-level fallback also clears stale history when the identity DOM is
  // empty and an older integration has not installed transcriptLifecycle.
  document.addEventListener('hyperaudioInit', () => reset('hyperaudioInit'));

  function injectControls() {
    if (document.getElementById('transcript-undo')) return;
    const strike = document.getElementById('strikethrough');
    if (!strike || !strike.parentNode) return;
    const undo = document.createElement('button');
    undo.id = 'transcript-undo';
    undo.type = 'button';
    undo.className = 'btn btn-square btn-outline tooltip';
    undo.dataset.tip = 'Undo';
    undo.setAttribute('aria-label', 'Undo transcript edit');
    undo.style.marginRight = '4px';
    undo.textContent = '↶';
    const redo = document.createElement('button');
    redo.id = 'transcript-redo';
    redo.type = 'button';
    redo.className = 'btn btn-square btn-outline tooltip';
    redo.dataset.tip = 'Redo';
    redo.setAttribute('aria-label', 'Redo transcript edit');
    redo.style.marginRight = '4px';
    redo.textContent = '↷';
    strike.parentNode.insertBefore(redo, strike);
    strike.parentNode.insertBefore(undo, redo);
    undo.addEventListener('click', () => restore(-1, { focus: true }));
    redo.addEventListener('click', () => restore(1, { focus: true }));
    document.getElementById('caption-editor-btn').addEventListener('click', updateControls);
    document.getElementById('transcript-editor-btn').addEventListener('click', updateControls);
  }

  injectControls();
  reset('initial');

  window.transcriptHistory = Object.freeze({
    undo: (options) => restore(-1, options),
    redo: (options) => restore(1, options),
    canUndo: () => !captionMode() && position > 0,
    canRedo: () => !captionMode() && position >= 0 && position < entries.length - 1,
    reset,
    flushPending: clearPending,
    // Diagnostics used by bounded-history and cross-engine protocol tests.
    inspect: () => ({ length: entries.length, position, totalBytes }),
  });
})();

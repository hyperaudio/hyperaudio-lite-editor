/* Bounded hybrid undo/redo for the live transcript DOM (#400, #517). */

(function () {
  'use strict';

  const MAX_ENTRIES = 100;
  // 48MB, raised from 12MB in #510. Full checkpoints remain proportional to
  // document size; ordinary collapsed typing now stores paragraph deltas, so
  // this cap mainly bounds mixed histories and large structural operations.
  const MAX_BYTES = 48 * 1024 * 1024;
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
  let fullSnapshotCount = 0;
  let paragraphSnapshotCount = 0;

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

  // FNV-1a over the fingerprint string, suffixed with its length. Equality of
  // hashes stands in for equality of strings at the fold sites; a collision
  // would merely fold one normalize pass it shouldn't have (one lost undo
  // step), and the length guard makes that astronomically unlikely.
  function fingerprintHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36) + ':' + str.length;
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
    fullSnapshotCount += 1;
    const clone = cleanClone(root);
    const html = clone.innerHTML;
    // The fingerprint is only ever compared for EQUALITY (the fold decisions
    // below) — never read as content — so it is stored as a hash, not the
    // string. Measured on a real interview transcript (#510): the fingerprint
    // string is the same order of magnitude as the HTML, and storing both,
    // counted as UTF-16, cost ~2.9MB per entry — the 12MB cap then held four
    // entries, and undo was three steps deep on ordinary content. The length
    // rides along as a collision guard.
    const fingerprint = fingerprintHash(semanticFingerprint(clone));
    return Object.freeze({
      kind: 'full',
      html,
      semanticFingerprint: fingerprint,
      selection: captureSelection(root),
      origin: origin || 'unknown',
      timestamp: Date.now(),
      bytes: html.length * 2,
    });
  }

  function paragraphBefore(origin) {
    const root = validTranscript();
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount !== 1 || !selection.isCollapsed) return null;
    const node = selection.anchorNode;
    const element = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
    const paragraph = element && element.closest ? element.closest('p') : null;
    if (!paragraph || !root.contains(paragraph)) return null;
    const paragraphs = Array.from(root.querySelectorAll('p'));
    const paragraphIndex = paragraphs.indexOf(paragraph);
    if (paragraphIndex < 0) return null;
    const clone = cleanClone(paragraph);
    paragraphSnapshotCount += 1;
    return Object.freeze({
      kind: 'paragraph-before',
      paragraph,
      paragraphIndex,
      paragraphCount: paragraphs.length,
      html: clone.outerHTML,
      selection: captureSelection(paragraph),
      origin: origin || 'unknown',
      timestamp: Date.now(),
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

  function entryAfterSelection(entry) {
    return entry.kind === 'paragraph' ? entry.afterSelection : entry.selection;
  }

  function paragraphSelectionInRoot(root, paragraphIndex, saved) {
    if (!saved) return saved;
    // Paragraph entries use offsets relative to their own scope. Full entries
    // are restored against the transcript root, so promotion must add the
    // preceding transcript text exactly once.
    const paragraph = root.querySelectorAll('p')[paragraphIndex];
    if (!paragraph) return null;
    const base = pointOffset(root, paragraph, 0);
    if (base === null) return null;
    return {
      anchor: base + saved.anchor,
      focus: base + saved.focus,
      backward: saved.backward,
    };
  }

  function entrySelectionInRoot(root, entry, selection) {
    return entry.kind === 'paragraph'
      ? paragraphSelectionInRoot(root, entry.paragraphIndex, selection)
      : selection;
  }

  function replaceParagraph(container, paragraphIndex, html) {
    const paragraph = container.querySelectorAll('p')[paragraphIndex];
    if (!paragraph) return false;
    const template = document.createElement('template');
    template.innerHTML = html;
    const replacement = template.content.firstElementChild;
    if (!replacement || !replacement.matches('p')) return false;
    paragraph.replaceWith(replacement);
    return true;
  }

  function materialize(wantedPosition) {
    if (wantedPosition < 0 || wantedPosition >= entries.length) return null;
    let checkpoint = wantedPosition;
    while (checkpoint >= 0 && entries[checkpoint].kind !== 'full') checkpoint -= 1;
    if (checkpoint < 0) return null;
    const container = document.createElement('div');
    container.innerHTML = entries[checkpoint].html;
    for (let index = checkpoint + 1; index <= wantedPosition; index += 1) {
      const entry = entries[index];
      if (entry.kind === 'full') container.innerHTML = entry.html;
      else if (!replaceParagraph(container, entry.paragraphIndex, entry.afterHtml)) return null;
    }
    return container.innerHTML;
  }

  function checkpointFrom(positionToMaterialize, source) {
    const html = materialize(positionToMaterialize);
    if (html === null) return null;
    const container = document.createElement('div');
    container.innerHTML = html;
    return Object.freeze({
      kind: 'full',
      html,
      semanticFingerprint: fingerprintHash(semanticFingerprint(container)),
      selection: entrySelectionInRoot(container, source, entryAfterSelection(source)),
      origin: 'history-checkpoint',
      timestamp: Date.now(),
      bytes: html.length * 2,
    });
  }

  function prune() {
    while (entries.length > 1 && (entries.length > MAX_ENTRIES || totalBytes > MAX_BYTES)) {
      const nextBaseline = checkpointFrom(1, entries[1]);
      if (!nextBaseline) break;
      totalBytes += nextBaseline.bytes - entries[0].bytes - entries[1].bytes;
      entries.splice(0, 2, nextBaseline);
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

  function push(next) {
    if (!next) return false;
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

  function fullEntry(before, after) {
    return Object.freeze({
      kind: 'full',
      html: after.html,
      semanticFingerprint: after.semanticFingerprint,
      beforeSelection: before.selection,
      selection: after.selection,
      origin: after.origin,
      timestamp: after.timestamp,
      bytes: after.bytes,
    });
  }

  function localEntry(before, origin) {
    const root = validTranscript();
    if (!root || !before.paragraph.isConnected) return null;
    const paragraphs = root.querySelectorAll('p');
    if (paragraphs.length !== before.paragraphCount
        || paragraphs[before.paragraphIndex] !== before.paragraph) return null;
    const clone = cleanClone(before.paragraph);
    const afterHtml = clone.outerHTML;
    if (afterHtml === before.html) return null;
    return Object.freeze({
      kind: 'paragraph',
      paragraphIndex: before.paragraphIndex,
      beforeHtml: before.html,
      afterHtml,
      beforeSelection: before.selection,
      afterSelection: captureSelection(before.paragraph),
      origin: origin || before.origin,
      timestamp: Date.now(),
      bytes: (before.html.length + afterHtml.length) * 2,
    });
  }

  function stateSnapshot(origin) {
    const root = validTranscript();
    const html = materialize(position);
    if (!root || html === null) return snapshot(origin);
    const container = document.createElement('div');
    container.innerHTML = html;
    return Object.freeze({
      kind: 'full',
      html,
      semanticFingerprint: fingerprintHash(semanticFingerprint(container)),
      selection: entrySelectionInRoot(container, entries[position],
        entryAfterSelection(entries[position])),
      origin: origin || 'history-state',
      timestamp: Date.now(),
      bytes: html.length * 2,
    });
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

  // Paste is a forced boundary (the design contract), but it arrives as
  // execCommand('insertText') — the #487 paste path — which is
  // indistinguishable from typing by inputType alone, so it coalesced into an
  // adjacent typing entry within the 500ms window (#514). The capture-phase
  // paste listener below raises this flag before the editor's own paste
  // handler runs; the commit it produces is then forced to its own entry, and
  // the chain is severed on BOTH sides so following typing starts fresh too.
  let pasteBoundary = false;

  function commitNative(before, inputType, origin) {
    if (before && before.kind === 'paragraph-before') {
      const local = localEntry(before, origin || inputType);
      if (local) {
        const category = inputCategory(inputType);
        const now = Date.now();
        const coalesce = !pasteBoundary && lastNative
          && lastNative.category === category
          && now - lastNative.at <= COALESCE_MS
          && lastNative.generation === (window.transcriptLifecycle
            ? window.transcriptLifecycle.generation() : 0)
          && sameSelection(lastNative.selection, local.beforeSelection)
          && position === entries.length - 1
          && entries[position].kind === 'paragraph'
          && entries[position].paragraphIndex === local.paragraphIndex;
        if (coalesce) {
          const current = entries[position];
          replaceCurrent(Object.freeze({
            ...current,
            afterHtml: local.afterHtml,
            afterSelection: local.afterSelection,
            timestamp: local.timestamp,
            bytes: (current.beforeHtml.length + local.afterHtml.length) * 2,
          }));
        } else push(local);
        lastNative = {
          category,
          at: now,
          selection: local.afterSelection,
          generation: window.transcriptLifecycle ? window.transcriptLifecycle.generation() : 0,
        };
        return;
      }
      before = stateSnapshot(`before-${inputType}`);
    }
    const after = snapshot(origin || inputType);
    if (!after || !before || before.semanticFingerprint === after.semanticFingerprint) return;
    const category = inputCategory(inputType);
    const now = Date.now();
    const coalesce = !pasteBoundary && !boundaryInput(inputType) && lastNative
      && lastNative.category === category
      && now - lastNative.at <= COALESCE_MS
      && lastNative.generation === (window.transcriptLifecycle
        ? window.transcriptLifecycle.generation() : 0)
      && sameSelection(lastNative.selection, before.selection)
      && position === entries.length - 1;
    const entry = fullEntry(before, after);
    if (coalesce && entries[position].kind === 'full' && position > 0) {
      replaceCurrent(Object.freeze({
        ...entry,
        beforeSelection: entries[position].beforeSelection,
      }));
    } else push(entry);
    if (pasteBoundary) {
      // sever the trailing side too: typing right after a paste must not
      // coalesce into the paste's entry (#514 — paste arrives as insertText
      // via the #487 handler and is indistinguishable by inputType)
      pasteBoundary = false;
      lastNative = null;
      return;
    }
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
    const operation = direction < 0 ? entries[position] : entries[nextPosition];
    const root = transcript();
    const origin = direction < 0 ? 'undo' : 'redo';
    gateway.restoring(() => {
      let selectionRoot = root;
      let savedSelection;
      if (operation.kind === 'paragraph') {
        const html = direction < 0 ? operation.beforeHtml : operation.afterHtml;
        if (replaceParagraph(root, operation.paragraphIndex, html)) {
          selectionRoot = root.querySelectorAll('p')[operation.paragraphIndex];
          savedSelection = direction < 0
            ? operation.beforeSelection : operation.afterSelection;
        } else {
          root.innerHTML = materialize(nextPosition) || root.innerHTML;
          savedSelection = entryAfterSelection(entries[nextPosition]);
        }
      } else {
        root.innerHTML = direction < 0
          ? (materialize(nextPosition) || root.innerHTML) : operation.html;
        savedSelection = direction < 0 ? operation.beforeSelection : operation.selection;
      }
      if (options && options.focus) root.focus({ preventScroll: true });
      restoreSelection(selectionRoot, savedSelection, false);
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
    if (transaction.captureHistory === false) {
      gatewayBefore = null;
      return;
    }
    gatewayBefore = snapshot(`before-${transaction.origin}`);
  });

  gateway.onAfterMutate((transaction) => {
    if (transaction.captureHistory === false) {
      gatewayBefore = null;
      updateControls();
      return;
    }
    const before = gatewayBefore;
    gatewayBefore = null;
    const after = snapshot(transaction.origin);
    if (!after || !before || before.semanticFingerprint === after.semanticFingerprint) {
      updateControls();
      return;
    }
    if (transaction.foldPolicy === 'normalization' && position >= 0) {
      if (position === 0) replaceCurrent(after);
      else {
        const current = entries[position];
        let beforeSelection = current.beforeSelection;
        if (current.kind === 'paragraph') {
          const previousHtml = materialize(position - 1);
          if (previousHtml === null) beforeSelection = null;
          else {
            const previous = document.createElement('div');
            previous.innerHTML = previousHtml;
            beforeSelection = entrySelectionInRoot(previous, current,
              current.beforeSelection);
          }
        }
        replaceCurrent(Object.freeze({
          ...fullEntry({ selection: beforeSelection }, after),
          origin: transaction.origin,
        }));
      }
    } else {
      push(fullEntry(before, after));
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
    const inputType = event.inputType || 'native';
    pendingNative = {
      // A raised pasteBoundary forces FULL capture (#514 × the delta design):
      // paste arrives as insertText via the #487 handler and would otherwise
      // qualify for the paragraph-local delta path, whose coalescing knows
      // nothing of paste — the design's own contract is that paste remains a
      // full checkpoint.
      before: inputType === 'insertText' && !pasteBoundary
        ? (paragraphBefore(`before-${inputType}`) || snapshot(`before-${inputType}`))
        : snapshot(`before-${inputType}`),
      inputType,
    };
    if (boundaryInput(pendingNative.inputType)) lastNative = null;
  }, true);

  document.addEventListener('paste', (event) => {
    if (!inTranscript(event.target) || captionMode()) return;
    pasteBoundary = true;
    lastNative = null; // the paste cannot join the entry before it
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
    commitNative(pending ? pending.before : stateSnapshot(`before-${event.inputType || 'native'}`),
      pending ? pending.inputType : (event.inputType || 'native'), event.inputType || 'native');
  }, true);

  document.addEventListener('compositionstart', (event) => {
    if (!inTranscript(event.target) || captionMode()) return;
    composing = true;
    clearPending();
    compositionBefore = snapshot('before-composition');
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
    inspect: () => ({
      length: entries.length,
      position,
      totalBytes,
      fullSnapshotCount,
      paragraphSnapshotCount,
      // Compatibility alias for point-1 benchmark reports.
      reusedSnapshotCount: paragraphSnapshotCount,
      localEntries: entries.filter((entry) => entry.kind === 'paragraph').length,
      fullEntries: entries.filter((entry) => entry.kind === 'full').length,
    }),
  });
})();

/* Extracted verbatim from index.html (#334) — loaded as a classic script in the same document order. */

  // Show the app version (from <meta name="version">) in the info modal, so a
  // bug report can say exactly which build it is — including a stale cached one.
  {
    const versionMeta = document.querySelector('meta[name="version"]');
    const versionOut = document.getElementById('app-version');
    if (versionMeta !== null && versionOut !== null) {
      versionOut.textContent = `Editor v${versionMeta.content}`;
    }
  }

  // Populates the Transcription section of the info modal. Called by the
  // transcription modules (Whisper, Deepgram) when a transcription completes.
  function setTranscriptionInfo(info) {
    const container = document.getElementById("transcription-info");
    if (container === null) {
      return;
    }
    const rows = [];
    if (info.service) rows.push(["Service", info.service]);
    if (info.model) rows.push(["Model", info.model]);
    if (info.language) rows.push(["Language", info.language]);
    if (info.device) rows.push(["Processing", info.device]);
    if (typeof info.seconds === "number") {
      const minutes = Math.floor(info.seconds / 60);
      const seconds = Math.round(info.seconds % 60);
      rows.push(["Time taken", minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`]);
    }
    container.innerHTML = rows.map(([label, value]) => `<p><strong>${label}:</strong> ${value}</p>`).join("");
  }

  // While a transcription is in flight the transcript container holds loader
  // markup, not a transcript – typing into it would be silently destroyed
  // when the result lands. Transcription modules call this around their work.
  function setTranscriptBusy(busy) {
    const transcript = document.getElementById("hypertranscript");
    if (transcript === null) {
      return;
    }
    transcript.setAttribute("contenteditable", String(!busy));
    if (busy) {
      transcript.setAttribute("aria-busy", "true");
    } else {
      transcript.removeAttribute("aria-busy");
    }
  }


  let updateCaptionsFromTranscript = true;
  let captionMode = false; // used to detect whether we need to sanitise amongst other things
  let transcriptRequiresInit = false; // to know whether a transcript has been loaded while in captionMode and so not initialised

  function mutateTranscript(fn, origin, foldPolicy) {
    if (window.transcriptGateway && typeof window.transcriptGateway.mutate === 'function') {
      return window.transcriptGateway.mutate(fn, { origin, foldPolicy });
    }
    return fn();
  }

  let alertOkBtn = document.querySelector('#captionsource-alert-ok');

  alertOkBtn.addEventListener('click', function() {
    document.querySelector('#captionsource-alert').style.visibility = "hidden";
  });

  let alertCancelBtn = document.querySelector('#captionsource-alert-cancel');

  alertCancelBtn.addEventListener('click', function() {
    document.querySelector('#captionsource-alert').style.visibility = "hidden";
    localStorage.setItem("noCaptionAlert", "true");
  });

  let editableDiv = document.querySelector('#hypertranscript');

  // The transcript is time-aligned speech, not a rich-text document: a word is a
  // <span data-m data-d> and the model carries no formatting. But #hypertranscript
  // is a plain contenteditable, so the browser's own formatting commands applied
  // anyway — ⌘B wrapped the selected word spans in <b>, which the writer then
  // flattened away on save, silently losing what the user had just applied.
  //
  // Suppress the whole family rather than named shortcuts. beforeinput (not
  // keydown) is the hook that catches every route into it — keyboard, the
  // right-click menu, and the macOS Format/Edit menu bar — and inputType tells us
  // which operation it is. Every format* type either injects an element or sets a
  // style the transcript doesn't model, formatRemove included: nothing gets in, so
  // there is nothing to clear (anything that does arrive — legacy files, or a
  // paste per #487 — is flattened by the writer anyway).
  //
  // The editor's OWN strikethrough (redaction) sets span.style programmatically
  // and never goes through either hook, so it is unaffected.
  //
  // Two hooks, because neither covers the ground alone:
  //  - keydown stops ⌘/Ctrl+B/I/U, which is how this is actually reached (no UI
  //    offers it). Deterministic, and the only route testable in our headless
  //    Chromium, where the shortcut is otherwise inert.
  //  - beforeinput catches format* from routes that raise it instead — a menu
  //    bar, a context menu — and covers types no shortcut has. Measured caveat:
  //    document.execCommand('bold') raises NO beforeinput in Chromium, so this
  //    is not a general "no formatting can ever appear" guarantee; it closes the
  //    user-reachable routes. Markup that still gets in (legacy files, a paste
  //    per #487) is flattened by the writer on save.
  editableDiv.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && /^[biu]$/i.test(e.key)) {
      e.preventDefault();
    }
  });

  editableDiv.addEventListener('beforeinput', function (e) {
    if (typeof e.inputType === 'string' && e.inputType.startsWith('format')) {
      e.preventDefault();
    }
  });

  // Paste the clipboard's PLAIN text as plain text (#487). insertHTML parsed it
  // as markup, so anything between < and > became an element instead of
  // characters: pasting the literal "<inaudible>" produced an empty <inaudible>
  // element and the word rendered as nothing — silently destroyed, and absent
  // from the saved JSON. insertText inserts characters, so angle brackets
  // survive as text (the invariant transcript-serializer.js already documents
  // for words like "<inaudible>", #406/#409), and it still participates in
  // native contenteditable undo, which matters until #400 owns undo itself.
  //
  // The "&nbsp;" replacement that stood here was a no-op — it discarded its
  // return value, and plain-text clipboard content carries U+00A0 rather than
  // that literal string. It was guarding against insertHTML decoding a pasted
  // "&nbsp;" into a space, which insertText cannot do. normalizeTranscriptSpans
  // converts real nbsp characters on the next pass either way (#339).
  editableDiv.addEventListener("paste", function(e) {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  });

  window.document.addEventListener('hyperaudioInit', hyperaudio, false);
  window.document.addEventListener('hyperaudioGenerateCaptionsFromTranscript', hyperaudioGenerateCaptionsFromTranscript, false);
  let hyperaudioTemplate = "";

  fetch('hyperaudio-template.html?v=1.1.7') // bump with the template — an unversioned fetch served stale copies from the browser cache
  .then(function(response) {
      // When the page is loaded convert it to text
      return response.text()
  })
  .then(function(html) {
    hyperaudioTemplate = html;
  })
  .catch(function(err) {
      console.log('Failed to fetch page: ', err);
  });

  // Interactive-transcript export dialog. The exported page links the media by a
  // RELATIVE path (or its URL), never the session-only blob: URL — so, saved
  // next to the media file, it plays and stays interactive (the template already
  // loads the hyperaudio-lite lib from CDN and boots it). The user confirms the
  // media reference because a freshly-uploaded file's real name isn't retained.
  {
    const iaModal = document.getElementById('interactive-export-modal');
    const iaInput = document.getElementById('interactive-media-filename');
    const iaDownload = document.getElementById('interactive-export-download');

    // Best media reference to link in the exported interactive transcript, for the
    // CURRENT media. A plain remote URL is usable directly from the player src; but
    // a local upload (blob:) and an HLS source (blob: MediaSource) carry no usable
    // URL, so those paths stamp the real reference on #hyperplayer.dataset.mediaRef
    // (the filename for a local file, the original URL for remote/HLS — set by the
    // local-file capture below and by attachMediaPlayback in hls-source.js). Prefer
    // the http(s) src when present so a fresh remote URL always wins over a stale
    // ref; otherwise use the stamped ref.
    const guessMediaSrc = () => {
      const player = document.querySelector('#hyperplayer');
      const src = player ? player.src : '';
      if (/^https?:/i.test(src)) return src;
      return (player && player.dataset.mediaRef) || '';
    };

    // Record the real filename of a locally-loaded media file (a blob: URL carries
    // no name). Read centrally from any media file input; import inputs (JSON/SRT/
    // VTT) are skipped by the media check.
    const MEDIA_EXTENSION = /\.(mp4|webm|ogv|ogg|mov|m4v|mkv|mp3|m4a|wav|aac|flac|opus)$/i;
    document.addEventListener('change', (e) => {
      const input = e.target;
      if (!input || input.type !== 'file' || !input.files || input.files.length === 0) return;
      const file = input.files[0];
      const isMedia = /^(audio|video)\//i.test(file.type || '') || MEDIA_EXTENSION.test(file.name);
      if (!isMedia) return;
      const player = document.querySelector('#hyperplayer');
      if (player) player.dataset.mediaRef = file.name;
    }, true);

    if (iaModal !== null && iaInput !== null) {
      // Refresh the field to the current media every time the dialog opens, so a
      // value left over from a previous clip (or a name typed and abandoned) can
      // never be exported by mistake — the field always reflects what's loaded now.
      iaModal.addEventListener('change', () => {
        if (iaModal.checked) {
          iaInput.value = guessMediaSrc();
        }
      });
    }

    if (iaDownload !== null && iaInput !== null) {
      iaDownload.addEventListener('click', () => {
        const mediaSrc = iaInput.value.trim();
        if (mediaSrc === '') { iaInput.focus(); return; }
        const track = document.querySelector('#hyperplayer-vtt');
        // function replacements so a literal $ in the transcript/filename isn't
        // treated as a replacement pattern
        const html = hyperaudioTemplate
          .replace('{hypertranscript}', () => (typeof serializeTranscriptHtml === 'function'
            ? serializeTranscriptHtml(document.querySelector('#hypertranscript'))
            : getTranscriptData()))
          .replace('{sourcemedia}', () => mediaSrc)
          .replace('{sourcevtt}', () => (track !== null ? track.src : ''));
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'interactive-transcript.html';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        if (iaModal !== null) iaModal.checked = false;
      });
    }
  }

  /* ----------------------------------------------------------- */

  let transcriptCache = null;
  let captionCache = null;

  // A new transcript was just created with no captions of its own
  // (transcribe / JSON import / SRT-VTT import) — discard any cached caption
  // editor so the next entry rebuilds from the fresh transcript. Caption
  // edits otherwise persist; localStorage load manages its own cache.
  window.document.addEventListener('hyperaudioInit', () => {
    captionCache = null;
    // A fresh transcript just landed: its machine captions ARE
    // transcript-derived, so caption sync defaults ON. Nothing reset this
    // before, so a new transcription INHERITED the flag from whatever was
    // open previously — after any project with curated captions, edits to
    // the new transcript updated neither the video captions nor the caption
    // editor. Importers that carry curated captions (VTT/SRT) set the flag
    // false AFTER dispatching this event, and the project-open path applies
    // saved options without firing it at all.
    updateCaptionsFromTranscript = true;
  }, false);

  // Segmented view switch (transcript/captions): both segments stay clickable
  // and the active one is marked by the track's thumb + aria-pressed rather
  // than disabled.
  // Clicking the active segment is a no-op — the transcription engines rely on
  // that when they force transcript view by clicking #transcript-editor-btn.
  const transcriptViewBtn = document.querySelector('#transcript-editor-btn');
  const captionViewBtn = document.querySelector('#caption-editor-btn');

  function reflectViewSwitch() {
    document.querySelector('#view-switch').classList.toggle('captions-active', captionMode === true);
    captionViewBtn.setAttribute('aria-pressed', String(captionMode === true));
    transcriptViewBtn.setAttribute('aria-pressed', String(captionMode !== true));
  }

  captionViewBtn.addEventListener('click', () => {
    if (captionMode === true) return;
    let holder = document.querySelector('.transcript-holder');
    transcriptCache = holder.cloneNode(true);
    captionMode = true;
    hyperaudioGenerateCaptionsFromTranscript();
    reflectViewSwitch();
  });

  transcriptViewBtn.addEventListener('click', () => {
    if (captionMode !== true) return;
    restoreTranscript();
    captionMode = false;
    if (transcriptRequiresInit === true) {
      hyperaudio();
      transcriptRequiresInit = false;
    }
    reflectViewSwitch();
  });


  /* ----------------------------------------------------------- */

  // --- Transcript span normalization (modular; set WORD_SPLIT_TIMING=false to
  // disable the split/merge/reflow timing repairs) ---------------------------
  // Top-level so BOTH the blur handler and the debounced sanitise pass can run
  // it — editing + clicking words to seek doesn't always fire a blur, so the
  // debounced pass keeps the spans (and the player's word index) correct
  // mid-edit too (#394).
  const WORD_SPLIT_TIMING = true;

  // Skip normalization while an IME composition is in flight — rewriting the
  // text nodes under an active composition (CJK etc.) breaks it. The skipped
  // pass simply happens on the next keyup/blur.
  let imeComposing = false;
  document.addEventListener('compositionstart', () => { imeComposing = true; });
  document.addEventListener('compositionend', () => { imeComposing = false; });

  // Estimate syllables from contiguous vowel groups (Latin-script heuristic);
  // floored at 1 so every part carries weight.
  function estimateSyllables(token) {
    const groups = token.toLowerCase().match(/[aeiouyàáâäãèéêëìíîïòóôöõùúûüýÿ]+/g);
    return Math.max(1, groups ? groups.length : 1);
  }

  // Split one multi-word span into per-word spans, dividing the original
  // duration by syllable weight (last part absorbs the rounding remainder).
  function splitWordSpan(span) {
    const tokens = span.textContent.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length < 2) return;
    const m = parseInt(span.getAttribute('data-m'), 10) || 0;
    const d = parseInt(span.getAttribute('data-d'), 10) || 0;
    const weights = tokens.map(estimateSyllables);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const frag = document.createDocumentFragment();
    let start = m;
    let allocated = 0;
    for (let i = 0; i < tokens.length; i++) {
      const dur = i === tokens.length - 1
        ? Math.max(0, d - allocated)
        : Math.round((d * weights[i]) / totalWeight);
      allocated += dur;
      const part = span.cloneNode(false);
      part.setAttribute('data-m', String(start));
      part.setAttribute('data-d', String(dur));
      part.textContent = tokens[i] + ' ';
      frag.appendChild(part);
      start += dur;
    }
    span.replaceWith(frag);
  }

  // --- Caret preservation across normalization -------------------------------
  // The span repairs rewrite text nodes (textContent =, replaceWith), which
  // destroys the browser's selection anchor — mid-edit the caret jumped to the
  // start of the joined/split word. All the passes preserve the transcript's
  // character CONTENT though, so the caret can be saved as an absolute
  // character offset and re-resolved onto whatever nodes exist afterwards.
  // Both endpoints are saved so a non-collapsed SELECTION (e.g. words selected
  // for striking) survives too, not just a caret.
  function saveCaretOffset(root) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const measure = (container, offset) => {
      const pre = document.createRange();
      pre.selectNodeContents(root);
      pre.setEnd(container, offset);
      return pre.toString().length;
    };
    return {
      start: measure(range.startContainer, range.startOffset),
      end: range.collapsed ? null : measure(range.endContainer, range.endOffset),
    };
  }

  // Resolve an absolute character offset back to a (text node, offset) pair;
  // clamps past-the-end to the final position.
  function resolveCharOffset(root, chars) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    let last = null;
    let remaining = chars;
    while ((node = walker.nextNode())) {
      if (remaining <= node.nodeValue.length) {
        return { node, offset: remaining };
      }
      remaining -= node.nodeValue.length;
      last = node;
    }
    return last ? { node: last, offset: last.nodeValue.length } : null;
  }

  function restoreCaretOffset(root, saved) {
    const start = resolveCharOffset(root, saved.start);
    if (start === null) return;
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    if (saved.end !== null) {
      const end = resolveCharOffset(root, saved.end);
      if (end !== null) range.setEnd(end.node, end.offset);
    } else {
      range.collapse(true);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Scrub contenteditable artifacts (#415): WebKit injects inline styles
  // (font-size etc.) on paste/splits, plus style-only wrapper spans with no
  // data-m — all of which persisted into exports and confused downstream
  // consumers. Only two inline styles are FUNCTIONAL on transcript spans:
  // line-through (the strikeout/cut model) and display on speaker labels (the
  // Speakers toggle). Preserve those, drop everything else, and unwrap
  // non-data-m wrapper spans so their text folds back into the flow.
  // Returns whether any span was UNWRAPPED — the one scrub action that moves
  // the caret's text node, so callers know the selection may need restoring
  // (#511). The style strip touches attributes only and cannot move a caret.
  function scrubEditingArtifacts(root) {
    root.querySelectorAll('span[style]').forEach((span) => {
      const display = span.classList.contains('speaker') ? span.style.display : '';
      const struck = (span.style.textDecoration || '').includes('line-through');
      span.removeAttribute('style');
      if (display) span.style.display = display;
      if (struck) span.style.textDecoration = 'line-through';
    });
    let unwrapped = false;
    root.querySelectorAll('span:not([data-m])').forEach((span) => {
      if (span.classList.contains('speaker')) return;
      span.replaceWith(...span.childNodes);
      unwrapped = true;
    });
    return unwrapped;
  }

  // Spans containing a bracket belong to the SPEAKER machinery, not word
  // normalization (#416): "[Maria] The " must survive until sanitise's speaker
  // pass extracts the label — splitting it first turns "[Maria] " into a plain
  // word span (starts-with-[ AND ends-with-], which the extraction branch
  // skips), steals timing from the real word, and throws the caret. A bare "["
  // (not a complete [..] pair) also guards half-typed names during a pause.
  function isSpeakerText(span) {
    return span.textContent.indexOf('[') !== -1 || span.textContent.indexOf(']') !== -1;
  }

  // True when nothing but whitespace text sits between nodes a and b.
  function onlyWhitespaceBetween(a, b) {
    let n = a.nextSibling;
    while (n && n !== b) {
      if (n.nodeType === Node.ELEMENT_NODE) return false;
      if (n.nodeType === Node.TEXT_NODE && n.nodeValue.trim() !== '') return false;
      n = n.nextSibling;
    }
    return n === b;
  }

  // Repair a letter that LEAKED across a word boundary (#394): retyping a word's
  // first letter appends it after the PREVIOUS span's trailing space ("Lite " +
  // "Editor " -> "Lite E" + "ditor "). Signature: internal space + no trailing
  // space. Move the post-space fragment to the front of the next word span,
  // reconstituting the word with each span's ORIGINAL data-m/data-d intact.
  function reflowLeakedFragments(root) {
    let changed = false;
    const spans = Array.from(root.querySelectorAll('span[data-m]'));
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (!span.isConnected || span.classList.contains('speaker')) continue;
      if (isSpeakerText(span)) continue;
      const txt = span.textContent;
      if (!/\S\s+\S/.test(txt) || /\s$/.test(txt)) continue;
      const next = span.nextElementSibling;
      if (!next || !next.hasAttribute('data-m') || next.classList.contains('speaker')) continue;
      if (isSpeakerText(next)) continue;
      if (!onlyWhitespaceBetween(span, next)) continue;
      const cut = txt.lastIndexOf(' ');
      span.textContent = txt.slice(0, cut).replace(/\s+$/, '') + ' ';
      next.textContent = txt.slice(cut + 1) + next.textContent;
      changed = true;
    }
    return changed;
  }

  // Merge spans JOINED by deleting the space between two words — the inverse of
  // splitWordSpan (#394): a span with no trailing space, followed by a word
  // span, is glued back into one (start of first, end of last); chains for 3+.
  function mergeJoinedSpans(root) {
    let changed = false;
    const spans = Array.from(root.querySelectorAll('span[data-m]'));
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (!span.isConnected || span.classList.contains('speaker')) continue;
      if (isSpeakerText(span)) continue;
      while (span.textContent.length > 0 && !/\s$/.test(span.textContent)) {
        const next = span.nextElementSibling;
        if (!next || !next.hasAttribute('data-m') || next.classList.contains('speaker')) break;
        if (isSpeakerText(next)) break;
        if (!onlyWhitespaceBetween(span, next)) break;
        const m = parseInt(span.getAttribute('data-m'), 10) || 0;
        const nm = parseInt(next.getAttribute('data-m'), 10) || 0;
        const nd = parseInt(next.getAttribute('data-d'), 10) || 0;
        span.setAttribute('data-d', String(Math.max(0, (nm + nd) - m)));
        span.textContent = span.textContent + next.textContent;
        next.remove();
        changed = true;
      }
    }
    return changed;
  }

  // Run the span repairs on `root` and, if the set of word spans changed
  // (split added / merge removed), rebuild the player's word index so the new
  // spans highlight and removed ones don't linger. Reflow only moves text
  // between existing nodes, so it never changes the count. Called from both the
  // blur handler and the debounced sanitise pass.
  function normalizeTranscriptSpans(root) {
    if (!root || imeComposing) return;
    // The caret is measured BEFORE anything in this pass mutates text (#511).
    // The nbsp walk used to run first, and writing nodeValue on the text node
    // holding the caret collapses the selection to a node boundary —
    // saveCaretOffset then recorded that corpse and the restore faithfully
    // reproduced it, parking the caret before the word being typed after
    // every natural typing pause. Both pre-steps below preserve total
    // character count (nbsp→space is same-length; the artifact unwrap MOVES
    // text nodes rather than rewriting them), so offsets measured here stay
    // valid for the restore. Only when the transcript has focus — on blur
    // there is nothing to preserve.
    const hasFocus = document.activeElement === root;
    const caret = hasFocus ? saveCaretOffset(root) : null;
    // nbsp -> normal space (#339); flagged, because rewriting the caret's own
    // node is precisely the mutation that needs the restore afterwards
    let nbspRewritten = false;
    if (root.textContent.indexOf(' ') !== -1) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue.indexOf(' ') !== -1) {
          node.nodeValue = node.nodeValue.replace(/ /g, ' ');
          nbspRewritten = true;
        }
      }
    }
    // artifact hygiene runs regardless of the timing-repair switch (#415)
    const unwrapped = scrubEditingArtifacts(root);
    const preChanged = nbspRewritten || unwrapped;
    if (!WORD_SPLIT_TIMING) {
      // no timing repairs, but the pre-steps may still have broken the live
      // selection — restore before leaving (#511)
      if (caret !== null && preChanged) restoreCaretOffset(root, caret);
      return;
    }
    // disjoint conditions, in order: reflow (internal space + no trailing),
    // merge (no internal + no trailing), split (internal space + trailing).
    const reflowed = reflowLeakedFragments(root);
    let merged = mergeJoinedSpans(root);
    let split = false;
    const spans = root.querySelectorAll('span[data-m]');
    for (let i = 0; i < spans.length; i++) {
      if (!isSpeakerText(spans[i]) && /\S\s+\S/.test(spans[i].textContent)) {
        splitWordSpan(spans[i]);
        split = true;
      }
    }
    if (caret !== null && (preChanged || reflowed || merged || split)) {
      restoreCaretOffset(root, caret);
    }
    // Re-index whenever merge or split FIRED — not on a span-count comparison:
    // a merge (−1) plus a split (+1) in the same pass nets zero yet leaves
    // wordArr holding removed nodes and missing new ones. Reflow keeps the
    // span elements themselves, so it needs no re-index.
    const inst = window.hyperaudioInstance;
    if (inst && typeof inst.setupTranscriptWords === 'function'
        && (merged || split)) {
      inst.setupTranscriptWords();
      if (typeof inst.updateTranscriptVisualState === 'function') {
        const player = document.querySelector('#hyperplayer');
        const t = player && !isNaN(player.currentTime) ? player.currentTime : (inst.currentTime || 0);
        inst.updateTranscriptVisualState(t, true);
      }
    }
  }

  function hyperaudio() {
    // Leave a small gap below the navbar when autoscrolling the active paragraph
    // (passed natively as scrollOffset to the 2.5.x options-object constructor).
    // Clears the corner buttons' band (#480) while staying under the
    // inter-line gap: at 36 the previous line's bottom few pixels peeked into
    // the viewport top as a sliced sliver when autoscroll parked a paragraph.
    const SCROLL_TOP_GAP = 30;

    // hyperaudio() runs on every transcript (re)load — tear down the previous
    // instance so its player/document listeners don't accumulate (2.6.0 API).
    if (window.hyperaudioInstance && typeof window.hyperaudioInstance.destroy === 'function') {
      window.hyperaudioInstance.destroy();
    }

    const hyperaudioInstance = new HyperaudioLite({
      transcript: "hypertranscript",
      player: "hyperplayer",
      minimizedMode: false,
      autoScroll: true,
      doubleClick: true,
      webMonetization: false,
      playOnClick: false,
      scrollOffset: SCROLL_TOP_GAP,
      // The element that actually scrolls is .transcript-holder, not
      // #hypertranscript (the library default, which is absolutely positioned
      // and doesn't scroll here). Official option since 2.6.0 (#254).
      scrollContainer: document.querySelector('.transcript-holder'),
    });

    // Patch for #294: if the library's polling chain runs while wordArr
    // still references a span deleted by an in-progress edit, the original
    // can throw on a detached word's parentNode and the chain dies silently.
    // Strip detached entries before delegating — the next debounced
    // refreshHyperaudioInstance will rebuild wordArr from the live DOM.
    // (Kept under 2.6.0: the delta-update rewrite is more defensive but some
    // paths still walk parentNode on words an in-progress edit may detach.)
    const originalUpdateVisualState = hyperaudioInstance.updateTranscriptVisualState.bind(hyperaudioInstance);
    hyperaudioInstance.updateTranscriptVisualState = function (...args) {
      if (hyperaudioInstance.wordArr) {
        const live = hyperaudioInstance.wordArr.filter(w => w.n && w.n.parentNode);
        if (live.length !== hyperaudioInstance.wordArr.length) {
          hyperaudioInstance.wordArr = live;
        }
      }
      // forward all args (e.g. the second "force" flag the library passes on seek)
      return originalUpdateVisualState(...args);
    };

    window.hyperaudioInstance = hyperaudioInstance;

    // (The top-gap scrollToParagraph override is gone — 2.5.x applies it natively
    // via the scrollOffset option passed to the constructor above.)

    // Pause autoscroll while the user is actively typing so it doesn't yank the
    // view mid-edit; resume shortly after. Uses 'input' (content changes) so
    // clicking a word to seek still autoscrolls. Attach once per transcript node.
    const transcriptEl = document.querySelector('#hypertranscript');
    if (transcriptEl !== null && transcriptEl.dataset.autoscrollPause !== '1') {
      transcriptEl.dataset.autoscrollPause = '1';
      let typingResume = null;
      transcriptEl.addEventListener('input', () => {
        const hla = window.hyperaudioInstance;
        if (hla && typeof hla.pauseAutoscroll === 'function') {
          hla.pauseAutoscroll();
        }
        clearTimeout(typingResume);
        typingResume = setTimeout(() => {
          const inst = window.hyperaudioInstance;
          if (inst && typeof inst.resumeAutoscroll === 'function') {
            inst.resumeAutoscroll();
          }
        }, 1500);
      });

      // Word-span normalization (split/merge/reflow + re-index) runs on blur,
      // and the debounced sanitise pass runs it too so it also fires while
      // editing without a blur (e.g. clicking words to seek). See normalize-
      // TranscriptSpans above and the sanitise() call below.
      transcriptEl.addEventListener('blur', () => mutateTranscript(
        () => normalizeTranscriptSpans(transcriptEl),
        'normalize-blur',
        'normalization',
      ));
    }

    const sanitisationCheck = function () {

      let time = 0;
      resetTimer();
      window.onload = resetTimer;
      document.onkeyup = resetTimer;
      document.ontouchend = resetTimer;

      let rootnode = document.querySelector("#hypertranscript");
      let sourceMedia = document.querySelector("#hyperplayer").src;
      let track = document.querySelector('#hyperplayer-vtt');

      function sanitise() {
        let d = new Date();
        let starttime = d.getTime();

        // the container only holds a transcript when there are timed spans –
        // during transcription it holds loader or error markup whose text
        // nodes have no span siblings, and walking those used to throw
        if (rootnode.querySelector("span[data-m]") === null) {
          return;
        }

        // Repair split/merged/reflowed word spans on the debounced pass too, not
        // just on blur — editing while clicking words to seek never fires a blur,
        // so this keeps the spans and the player's word index correct mid-edit
        // (#394). Self-contained: it re-indexes when the span set changes.
        normalizeTranscriptSpans(rootnode);

        // check that transcript has the focus

        // check for focus
        let isTranscriptFocused = false;
        let isCaptionEditorFocused = false;


        if (document.activeElement === rootnode) {
          isTranscriptFocused = true;
        }


        let walker = document.createTreeWalker(rootnode, NodeFilter.SHOW_TEXT, null, false);

        while (walker.nextNode()) {

          if (walker.currentNode.textContent.replaceAll('\n', '').trim().length > 0
              && walker.currentNode.parentElement.tagName !== "SPAN") {

            // if previousSibling is a span, add the textContent of currentNode to it
            if (walker.currentNode.previousSibling !== null && walker.currentNode.previousSibling.tagName === "SPAN") {
              walker.currentNode.previousSibling.textContent += walker.currentNode.textContent;
            } else if (walker.currentNode.nextSibling !== null) {
              // assume nextSibling is a span for now and add textContent of currentNode to that
              walker.currentNode.nextSibling.textContent += walker.currentNode.textContent;
            } else {
              // orphan text node with no siblings at all – leave it alone
              continue;
            }

            // remove currentNode as we've merged its contents
            //walker.currentNode.parentNode.removeChild(walker.currentNode);
            walker.currentNode.textContent = "";
          }
        }

        // look for speakers and break them out into their own spans

        walker = document.createTreeWalker(rootnode, NodeFilter.SHOW_TEXT, null, false);

        while (walker.nextNode()) {
          if (walker.currentNode.textContent.replaceAll('\n', '').replaceAll('  ', ' ').trim().length > 0
              && walker.currentNode.parentElement.tagName === "SPAN" && walker.currentNode.textContent.includes('[') && walker.currentNode.textContent.includes(']')) {

            // if previousSibling is a span, add the textContent of currentNode to it
            if (walker.currentNode.textContent.trim().startsWith('[') === false || walker.currentNode.textContent.trim().endsWith(']') === false) {
             

              //look for text in square brackets — extract one label per pass;
              //any further bracketed labels stay in the text for the next pass
              //(match() returns an array: coercing it to a string corrupted
              //"[A] words [B]" into a single "[A], [B]" label)
              const regex = / *\[[^\]]*]/;
              const found = walker.currentNode.textContent.match(regex);

              // includes('[') + includes(']') admits reversed brackets
              // ("]foo[") with no complete [..] pair — nothing to extract
              if (found === null) { continue; }

              let startsWithSpeaker = false;
              if (walker.currentNode.textContent.trim().startsWith('[') === true){
                startsWithSpeaker = true;
              }

              walker.currentNode.textContent = walker.currentNode.textContent.replace(regex, '');

              let span = document.createElement("span");
              span.textContent = found[0] + ' ';

              if (span.textContent.includes('[') && span.textContent.includes(']')) {
                span.classList.add("speaker");
                closedSpeaker = false;
              }

              // add the classes of the current node
              span.classList.add(...walker.currentNode.parentNode.classList);
              //DOMTokenList.prototype.add.apply(span.classList, walker.currentNode.parentNode.classList);

              span.setAttribute("data-d","0");

              if (startsWithSpeaker === true) {
                span.setAttribute("data-m",walker.currentNode.parentNode.getAttribute("data-m"));
                walker.currentNode.parentNode.before(span);
              } else {
                let nextStart = walker.currentNode.parentNode.nextElementSibling.getAttribute("data-m");
                span.setAttribute("data-m",nextStart);
                let newSpan = document.createElement("span");
                newSpan.setAttribute("data-m",nextStart);

                newSpan.innerHTML = "&nbsp;";
                walker.currentNode.parentNode.after(span);
                span.after(newSpan);

                // set the cursor
                const range = document.createRange();
                const sel = window.getSelection();
                range.setStartBefore(newSpan.nextElementSibling);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
              }
            }
          }
        }

        // Canonical serialization (transcript-serializer.js): one span per
        // line, two-space indents, data-m before data-d, runtime noise
        // dropped. Replaces the old raw-innerHTML + strip-all-classes regex —
        // which also (wrongly) removed the semantic speaker class.
        let hypertranscript = typeof serializeTranscriptHtml === 'function'
          ? serializeTranscriptHtml(rootnode)
          : rootnode.innerHTML.replace(/ class=".*?"/g, '');
        document.querySelector('#download-html').setAttribute('href', 'data:text/html,'+encodeURIComponent(hypertranscript));

        if (isTranscriptFocused === true && updateCaptionsFromTranscript === true) {
          const words = document.querySelectorAll("[data-m]");
          hyperaudioInstance.wordArr = hyperaudioInstance.createWordArray(words);
          hyperaudioInstance.parentElements = hyperaudioInstance.transcript.getElementsByTagName(hyperaudioInstance.parentTag);

          if (hyperaudioInstance.currentTime !== undefined) {
            hyperaudioInstance.updateTranscriptVisualState(hyperaudioInstance.currentTime);
          }

          /*let hypertranscript = rootnode.innerHTML.replace(/ class=".*?"/g, '');
          document.querySelector('#download-html').setAttribute('href', 'data:text/html,'+encodeURIComponent(hypertranscript));*/

          generateCaptionsFromTranscript(hypertranscript, sourceMedia, track);
          const cap2 = caption();
          let subs = cap2.init("hypertranscript", "hyperplayer", '37' , '21'); // transcript Id, player Id, max chars, min chars for caption line
          //populateCaptionEditor(subs.data);
        }

        if (isCaptionEditorFocused === true && updateCaptionsFromTranscript === false) {
          generateCaptionsFromCaptionEditor();
        }

        d = new Date();
        //console.log("sanitising took "+(d.getTime() - starttime)+"ms");
      }

      function resetTimer() {
        clearTimeout(time);
        if (captionMode !== true) {
          time = setTimeout(() => mutateTranscript(
            sanitise,
            'sanitise',
            'normalization',
          ), 1000);
        }
      }

      // History restore replaces the transcript DOM synchronously. Cancel any
      // timer belonging to the pre-restore DOM and run exactly one fresh pass;
      // its explicit fold policy lets history amend the restored entry without
      // consuming redo or creating a visible step.
      window.hyperaudioNormalizeAfterHistoryRestore = function () {
        clearTimeout(time);
        if (captionMode === true || imeComposing === true) return false;
        mutateTranscript(sanitise, 'history-restore-normalize', 'normalization');
        return true;
      };

      //longpress to set playhead on mobile

      function longPress(element, callback) {
        let pressTimer;
        element.addEventListener("touchstart", function(e) {
          pressTimer = setTimeout(function() {
            callback(e);
          }, 2000);
        });
        element.addEventListener("touchend", function(e) {
          clearTimeout(pressTimer);
        });
      }

      longPress(rootnode, function(e) {
        const startTime = e.target.getAttribute('data-m');
        if (startTime !== null) {
          e.target.classList.add("active");
          hyperaudioInstance.myPlayer.setTime(startTime/1000);
          hyperaudioInstance.setPlayHead(e);
          hyperaudioInstance.checkPlayHead();
        }
      });

    };

    sanitisationCheck();

    const videoElement = document.querySelector("#hyperplayer");
    let sidebarOpen = true;

    document.querySelector('#sidebar-toggle').addEventListener('click', (e) => {

      if (sidebarOpen === true) {
        document.querySelector('.holder').style.left = 0;
        document.querySelector('.main-panel').style.left = 0;
        document.querySelector('.transcript-holder').style.left = '16px';
        // slide the side panel off-screen too — otherwise it lingers
        // underneath and the video peeks through the 8px gap above the
        // floating transcript card (#375)
        document.querySelector('.side-panel').style.left = '-400px';
        document.querySelector('#sidebar-close-icon').style.display = "none";
        document.querySelector('#sidebar-open-icon').style.display = "block";
        sidebarOpen = false;
      } else {
        document.querySelector('.holder').style.left = "400px";
        document.querySelector('.main-panel').style.left = "400px";
        document.querySelector('.transcript-holder').style.left = "400px";
        document.querySelector('.side-panel').style.left = '0px';
        document.querySelector('#sidebar-close-icon').style.display = "block";
        document.querySelector('#sidebar-open-icon').style.display = "none";
        sidebarOpen = true;
      }

      document.querySelector('#sidebar-toggle').setAttribute('aria-pressed', String(sidebarOpen));
      // lets the CSS align the navbar's leading edge with the transcript card,
      // whose left gutter differs between the open and collapsed layouts
      document.body.classList.toggle('sidebar-collapsed', sidebarOpen === false);

      if(
        document.pictureInPictureEnabled &&
        !videoElement.disablePictureInPicture) {
        try {
          if (sidebarOpen === false) {
            videoElement.requestPictureInPicture();
          } else {
            document.exitPictureInPicture();
          }
        } catch(err) {
            console.error(err);
        }
      }
    });

    // On small screens the same button opens the Recents drawer instead
    // (responsive.js intercepts the click), so when the layout returns to
    // desktop restore aria-pressed to the desktop sidebar state.
    window.matchMedia('(max-width: 948px)').addEventListener('change', (ev) => {
      if (!ev.matches) {
        document.querySelector('#sidebar-toggle').setAttribute('aria-pressed', String(sidebarOpen));
      }
    });

    let showSpeakers = document.querySelector('#show-speakers');

    showSpeakers.addEventListener('change', function(e) {
      let speakers = document.querySelectorAll('.speaker');
      if (showSpeakers.checked === true) {
        speakers.forEach((speaker) => {
          //speaker.style.display = "inline";
          speaker.removeAttribute("style");
        });
      } else {
        speakers.forEach((speaker) => {
          speaker.style.display = "none";
        });
      }
    });
  }

  // (Removed the old ≤480px hack that cloned #hyperplayer into .transcript-holder
  // and deleted the original — the responsive layout (#349) now keeps the player
  // in its pinned pane, so moving it into the transcript broke both.)

  hyperaudio();

  function hyperaudioGenerateCaptionsFromTranscript() {
    let sourceMedia = document.querySelector("#hyperplayer").src;

    // Tear down the previous media's caption <track> before regenerating. A fresh
    // transcription reuses the same <video>/<track>; left in 'showing' mode the old
    // track keeps the PREVIOUS media's cue painted, so the new captions render on
    // top of the stale line (the "double captions" of #356/#287). The Recents-load
    // path already resets via resetCaptionTrack (storage.js) — the transcribe /
    // regenerate path must too. Fall back to the existing track if storage.js is
    // absent. (Note: this is the from-scratch entry point; the live-edit sanitise
    // path calls generateCaptionsFromTranscript directly and must NOT reset here,
    // or every keystroke would swap the track and churn the caption paint.)
    let track = (typeof resetCaptionTrack === 'function' && resetCaptionTrack())
      || document.querySelector('#hyperplayer-vtt');

    populateCaptionEditor(generateCaptionsFromTranscript(getTranscriptData(), sourceMedia, track));

    // Swapping the <track> element drops the old cue's DATA, but a PAUSED video
    // won't re-composite its native caption overlay on its own — so the previous
    // cue's PIXELS stay stranded on screen under the new captions (the remaining
    // half of #356/#287). flushCaptionPaint (hyperaudio-save.js) owns that
    // toggle now, so every caption path shares one implementation rather than
    // each route growing its own — the reason this bug kept returning. Inline
    // fallback kept for when that module is absent.
    if (typeof flushCaptionPaint === 'function') {
      flushCaptionPaint();
    } else {
      const player = document.getElementById('hyperplayer');
      const captionTrack = player && player.textTracks[0];
      if (captionTrack && captionTrack.mode === 'showing') {
        captionTrack.mode = 'hidden';
        captionTrack.mode = 'showing';
      }
    }
  }

  function generateCaptionsFromTranscript(hypertranscript, sourceMedia, track) {
    const cap1 = caption();
    let subs = null;
    
    if (captionMode === true) {
      subs = cap1.init("hypertranscript", "hyperplayer", '37' , '21', null, null, transcriptCache); 
    } else {
      subs = cap1.init("hypertranscript", "hyperplayer", '37' , '21');
    }

    document.querySelector('#download-vtt').setAttribute('href', 'data:text/vtt,'+encodeURIComponent(subs.vtt));
    document.querySelector('#download-srt').setAttribute('href', 'data:text/srt,'+encodeURIComponent(subs.srt));

    track.kind = "captions";
    //track.label = "English";
    //track.srclang = "en";
    track.src = "data:text/vtt,"+encodeURIComponent(subs.vtt);

    // check to see if it's an mp3 or m4a, in which case we don't display captions
    let extension = document.querySelector('#hyperplayer').src.split('.').pop();
    if (extension === "mp3" || extension === "m4a") {
      document.querySelector('#hyperplayer').textTracks[0].mode = "hidden";
    } else {
      document.querySelector('#hyperplayer').textTracks[0].mode = "showing";
    }
    // Defend this write against a stale caption.js straggler (#515): both the
    // sanitise and regenerate routes funnel through here, and until now they
    // survived only because caption.js defers its own write and registration
    // order happened to put the right one last — safety by accident. The
    // guard (hyperaudio-save.js) re-asserts this src/mode after any straggler
    // when media metadata is still pending; it is a no-op once loaded.
    if (typeof window.guardCurrentCaptionWrite === 'function') {
      window.guardCurrentCaptionWrite();
    }
    return subs.data;
  }

  function hasParent(element, parent) {
    let currentElement = element.parentNode;
    
    while (currentElement !== null) {
      if (currentElement === parent) {
        return true;
      }
      
      currentElement = currentElement.parentNode;
    }
    
    return false;
  }

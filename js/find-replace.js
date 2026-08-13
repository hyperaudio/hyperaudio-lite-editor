/**
 * find-replace.js
 * (C) The Hyperaudio Project
 * @version 1.3.4 — last changed in release 1.3.4
 * @license MIT
 *
 * Find & replace for the transcript (#25). "Find" reuses the vendored
 * searchPhrase() (js/hyperaudio-lite-extension.js), which highlights matches by
 * wrapping the matched substring in <mark class="search-mark">. This module adds
 * the replace UI on top — without touching the vendored extension:
 *
 *  - a toggle that reveals a replace box below the search box;
 *  - Replace (the active match) and Replace All;
 *  - prev/next stepping through matches, with the active match highlighted in a
 *    distinct colour (mark.search-mark.active) and scrolled into view.
 *
 * Each match is a <mark> inside a word span; replacing swaps only the mark's text
 * and leaves the span's data-m / data-d timing intact.
 *
 * A PHRASE is one match, not one per word (#557). searchPhrase marks exactly
 * one span per query word, in consecutive [data-m] spans, for every hit — so
 * the flat mark list groups cleanly into runs of that length. Stepping, the
 * counter and the active highlight all work on groups, and replacing a group
 * distributes the replacement's words across its spans so each keeps its own
 * timing.
 */

(function () {
  const searchBox = document.getElementById('search-box');
  const toggle = document.getElementById('find-replace-toggle');
  const panel = document.getElementById('replace-panel');
  const replaceBox = document.getElementById('replace-box');
  const countEl = document.getElementById('find-match-count');
  const prevBtn = document.getElementById('find-prev');
  const nextBtn = document.getElementById('find-next');
  const replaceOneBtn = document.getElementById('replace-one');
  const replaceAllBtn = document.getElementById('replace-all');
  const clearBtn = document.getElementById('search-clear');
  const closeBtn = document.getElementById('replace-close');

  if (searchBox === null || toggle === null || panel === null) return;

  let matches = [];       // groups of marks: one group per phrase occurrence
  let activeIndex = -1;

  // How many spans searchPhrase marks per hit. This must count the needles
  // the VENDORED search derives, not raw whitespace tokens: it strips
  // punctuation from each word and drops any that empties, so a query like
  // "big - pharma" yields two needles, not three. Counting tokens instead
  // grouped the marks in threes and misaligned every match after the first.
  // (Mirrors SEARCH_PUNCT in hyperaudio-lite-extension.js, which is vendored
  // and must not be imported from.)
  const QUERY_PUNCT = /[.,\-\/#!$%\^&\*;:{}=_`~()\?\s]/g;
  const queryWordCount = () => {
    const needles = searchBox.value
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(QUERY_PUNCT, ''))
      .filter(Boolean);
    return Math.max(1, needles.length);
  };

  const isOpen = () => !panel.hasAttribute('hidden');

  const clearActive = () => {
    document.querySelectorAll('#hypertranscript mark.search-mark.active')
      .forEach((m) => m.classList.remove('active'));
  };

  const renderActive = () => {
    matches.forEach((group, i) => group.forEach((m) => m.classList.toggle('active', i === activeIndex)));
    const active = activeIndex >= 0 ? matches[activeIndex] : null;
    if (active) {
      active[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    countEl.textContent = matches.length ? `${activeIndex + 1} / ${matches.length}` : '0 / 0';
    const has = matches.length > 0;
    [prevBtn, nextBtn, replaceOneBtn, replaceAllBtn].forEach((b) => {
      if (b !== null) b.disabled = !has;
    });
  };

  // Re-read the highlighted matches after a search run (or a replace).
  const collectMatches = (keepIndex) => {
    // Chunk the marks into one group per occurrence. (An overlapping hit —
    // "a a" against "a a a" — can leave a short final group; it is kept
    // rather than dropped, so nothing becomes unreachable.)
    const flat = Array.from(document.querySelectorAll('#hypertranscript mark.search-mark'));
    const per = queryWordCount();
    matches = [];
    for (let i = 0; i < flat.length; ) {
      if (flat[i].hasAttribute(WHOLE)) {
        matches.push([flat[i]]); // the whole phrase in one span: a match by itself
        i += 1;
      } else {
        matches.push(flat.slice(i, i + per));
        i += per;
      }
    }
    if (matches.length === 0) {
      activeIndex = -1;
    } else if (!keepIndex || activeIndex < 0) {
      activeIndex = 0;
    } else if (activeIndex >= matches.length) {
      activeIndex = matches.length - 1;
    }
    renderActive();
  };

  // The vendored search walks ONE needle per consecutive span, so a phrase
  // whose words all sit inside a single span never matches — which is every
  // multi-word speaker label ("[Teon Brooks] " is one span), making speaker
  // renames impossible (#568). This supplementary pass marks those
  // whole-in-one-span occurrences the vendored pass cannot see. The mark
  // carries data-whole-phrase so collectMatches treats it as a COMPLETE
  // match rather than chunking it by needle count.
  const WHOLE = 'data-whole-phrase';
  const markWholePhraseSpans = () => {
    const needles = searchBox.value
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(QUERY_PUNCT, ''))
      .filter(Boolean);
    if (needles.length < 2) return; // single needles are the vendored pass's job
    const joined = needles.join('');
    document.querySelectorAll('#hypertranscript [data-m]').forEach((span) => {
      if (span.querySelector('mark.search-mark') !== null) return; // already marked
      const raw = span.textContent;
      const normalised = raw.toLowerCase().replace(QUERY_PUNCT, '');
      if (!normalised.includes(joined)) return;
      // Walk the raw text consuming the needle characters, skipping the
      // punctuation and spaces between them, so the mark covers the phrase
      // exactly as written — "[Teon Brooks]" including its space.
      let start = -1;
      let ni = 0;
      for (let i = 0; i < raw.length && ni < joined.length; i += 1) {
        const ch = raw[i].toLowerCase();
        if (ch === joined[ni]) {
          if (ni === 0) start = i;
          ni += 1;
        } else if (QUERY_PUNCT.test(ch)) {
          QUERY_PUNCT.lastIndex = 0; // the /g regex is stateful in .test()
          if (ni > 0) continue;      // punctuation inside the phrase is skipped
        } else {
          QUERY_PUNCT.lastIndex = 0;
          ni = 0;
          start = -1;
        }
        QUERY_PUNCT.lastIndex = 0;
      }
      if (ni < joined.length || start < 0) return;
      let end = start;
      let consumed = 0;
      while (end < raw.length && consumed < joined.length) {
        const ch = raw[end].toLowerCase();
        if (ch === joined[consumed]) consumed += 1;
        end += 1;
      }
      const before = raw.slice(0, start);
      const hit = raw.slice(start, end);
      const after = raw.slice(end);
      span.textContent = '';
      if (before) span.append(before);
      const mark = document.createElement('mark');
      mark.className = 'search-mark';
      mark.setAttribute(WHOLE, '');
      mark.textContent = hit;
      span.append(mark);
      if (after) span.append(after);
      span.classList.add('search-match');
    });
  };

  // Run the existing search, then pick up its marks.
  const runSearch = (keepIndex) => {
    if (typeof searchPhrase === 'function') {
      searchPhrase(searchBox.value);
    }
    markWholePhraseSpans();
    collectMatches(keepIndex);
  };

  const step = (delta) => {
    if (matches.length === 0) return;
    activeIndex = (activeIndex + delta + matches.length) % matches.length;
    renderActive();
  };

  // Signal the editor that the transcript changed (programmatic DOM edits don't
  // fire input on their own), so it can mark the document dirty / re-caption.
  const markDirty = () => {
    const ht = document.getElementById('hypertranscript');
    if (ht !== null) ht.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // Replace one occurrence — a group of marks spanning consecutive word spans.
  // The replacement's words are distributed across the group so every span
  // keeps its own data-m / data-d: equal counts give one word per span (the
  // "big pharma" -> "Big Pharma" case, timings untouched); a longer
  // replacement puts the surplus in the last span; a shorter one empties the
  // spans left over, and any span reduced to nothing is removed with them.
  const replaceGroup = (group) => {
    const words = replaceBox.value.trim().split(/\s+/).filter(Boolean);
    const n = group.length;
    group.forEach((mark, i) => {
      const span = mark.closest('[data-m]') || mark.parentNode;
      let chunk;
      if (words.length === 0) {
        chunk = '';
      } else if (i < n - 1) {
        chunk = i < words.length ? words[i] : '';
      } else {
        chunk = words.slice(n - 1).join(' '); // the last span takes any surplus
      }
      mark.replaceWith(document.createTextNode(chunk));
      if (span && typeof span.normalize === 'function') span.normalize();
      // A span whose text is now empty holds no word: drop it rather than
      // leave a timed span with nothing in it for the sanitiser to trip on.
      if (span && span.hasAttribute && span.hasAttribute('data-m')
          && span.textContent.trim() === '') {
        span.remove();
      }
    });
  };

  const mutateTranscript = (fn, origin) => {
    if (window.transcriptGateway && typeof window.transcriptGateway.mutate === 'function') {
      return window.transcriptGateway.mutate(fn, { origin });
    }
    return fn();
  };

  const replaceOne = () => {
    if (activeIndex < 0 || !matches[activeIndex]) return;
    const at = activeIndex;
    mutateTranscript(() => {
      replaceGroup(matches[activeIndex]);
      markDirty();
    }, 'replace-one');
    runSearch(true);           // refresh; keep position so we land on the next hit
    if (matches.length) {
      activeIndex = Math.min(at, matches.length - 1);
      renderActive();
    }
  };

  const replaceAll = () => {
    if (matches.length === 0) return;
    mutateTranscript(() => {
      matches.forEach(replaceGroup);
      markDirty();
    }, 'replace-all');
    activeIndex = -1;
    runSearch(false);
  };

  const openPanel = () => {
    panel.removeAttribute('hidden');
    toggle.setAttribute('aria-expanded', 'true');
    document.body.classList.add('find-replace-open');
    runSearch(false);
    replaceBox.focus();
  };

  const closePanel = () => {
    panel.setAttribute('hidden', '');
    toggle.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('find-replace-open');
    clearActive();
  };

  // A hand correction changes the very spans the marks live in, so the match
  // list goes stale. Re-run the search once the edit settles (past the 1s
  // maintenance pass), then re-anchor to the first match at or after the
  // caret instead of dumping the user back at match 1 (#559).
  //
  // Re-running rewrites those spans, so the caret is measured as a character
  // offset within the transcript beforehand and restored after — the offset
  // survives the unwrap/re-wrap that node references would not.
  let editTimer = null;
  let selfEdit = false;

  const caretOffset = () => {
    const ht = document.getElementById('hypertranscript');
    const sel = window.getSelection();
    if (ht === null || sel === null || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!ht.contains(range.startContainer)) return null;
    const probe = range.cloneRange();
    probe.selectNodeContents(ht);
    probe.setEnd(range.startContainer, range.startOffset);
    return probe.toString().length;
  };

  const restoreCaret = (offset) => {
    const ht = document.getElementById('hypertranscript');
    if (ht === null || offset === null) return;
    const walker = document.createTreeWalker(ht, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let node = walker.nextNode();
    while (node !== null) {
      const len = node.textContent.length;
      if (seen + len >= offset) {
        const range = document.createRange();
        range.setStart(node, Math.max(0, Math.min(len, offset - seen)));
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      seen += len;
      node = walker.nextNode();
    }
  };

  // Which group sits at or after the caret — the match the user was working
  // on, or the next one down if their edit consumed it.
  const anchorToCaret = (offset) => {
    if (matches.length === 0 || offset === null) return;
    const ht = document.getElementById('hypertranscript');
    let seen = 0;
    const walker = document.createTreeWalker(ht, NodeFilter.SHOW_TEXT);
    const markStart = new Map();
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const mark = node.parentNode && node.parentNode.closest
        ? node.parentNode.closest('mark.search-mark') : null;
      if (mark !== null && !markStart.has(mark)) markStart.set(mark, seen);
      seen += node.textContent.length;
    }
    const at = matches.findIndex((group) => {
      const start = markStart.get(group[0]);
      return start !== undefined && start >= offset;
    });
    activeIndex = at === -1 ? matches.length - 1 : at;
    renderActive();
  };

  const transcriptEl = document.getElementById('hypertranscript');
  if (transcriptEl !== null) {
    transcriptEl.addEventListener('input', () => {
      if (!isOpen() || selfEdit || searchBox.value === '') return;
      clearTimeout(editTimer);
      editTimer = setTimeout(() => {
        const offset = caretOffset();
        selfEdit = true;
        try {
          runSearch(false);
          anchorToCaret(offset);
          restoreCaret(offset);
        } finally {
          selfEdit = false;
        }
      }, 1200); // past the maintenance pass, so the DOM has settled
    });
  }

  // A history restore replaces transcript.innerHTML, invalidating every mark
  // reference held in matches. Search is view state: clear its UI cache and do
  // not persist or automatically recreate highlights in the restored document.
  document.addEventListener('hyperaudioTranscriptRestored', () => {
    matches = [];
    activeIndex = -1;
    renderActive();
  });

  // Clearing the search (#558): searchPhrase('') unwraps every mark before
  // its empty-query early return, so one call retires the highlights, the
  // groups and the count together. The ✕ only shows when there is something
  // to clear; Escape in the search box does the same from the keyboard.
  const reflectClearBtn = () => {
    if (clearBtn !== null) clearBtn.hidden = searchBox.value === '';
  };
  const clearSearch = () => {
    searchBox.value = '';
    if (typeof searchPhrase === 'function') searchPhrase('');
    collectMatches(false);
    reflectClearBtn();
    searchBox.focus();
  };
  if (clearBtn !== null) clearBtn.addEventListener('click', clearSearch);
  // input covers typing/paste/cut; keyup is what the vendored search itself
  // hooks, and the only signal a programmatically-set value produces.
  searchBox.addEventListener('input', reflectClearBtn);
  searchBox.addEventListener('keyup', reflectClearBtn);
  searchBox.addEventListener('keydown', (e) => {
    // Escape clears a non-empty box; an empty one falls through to the
    // document handler, which closes the replace panel as before.
    if (e.key === 'Escape' && searchBox.value !== '') {
      e.stopPropagation();
      clearSearch();
    }
  });
  reflectClearBtn();

  toggle.addEventListener('click', () => { isOpen() ? closePanel() : openPanel(); });

  // Click outside the widget closes the panel — EXCEPT in the transcript
  // (#559). Correcting a match by hand starts with a click to place the
  // caret, and closing there punished exactly the flow the panel exists to
  // support. Clicks anywhere else still close it.
  document.addEventListener('click', (e) => {
    if (!isOpen() || !e.target.closest) return;
    if (e.target.closest('#find-replace') || e.target.closest('#hypertranscript')) return;
    closePanel();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) closePanel(); });

  // The extension already runs searchPhrase on search-box keyup — which
  // CLEARS every mark and re-applies only what it can see — so the
  // single-span pass has to run again after it, not just collect (#568).
  searchBox.addEventListener('keyup', () => {
    // The single-span pass belongs to SEARCH, not to the replace panel:
    // plain searching is the common case and must find the same phrases.
    // (Only the match bookkeeping below is panel-only.)
    markWholePhraseSpans();
    if (isOpen()) collectMatches(false);
  });

  // An explicit way out. Clicking away still closes the panel, but since
  // transcript clicks deliberately keep it open (#559) most of the screen no
  // longer dismisses it — so the exit has to be visible.
  if (closeBtn) closeBtn.addEventListener('click', () => { closePanel(); searchBox.focus(); });
  if (prevBtn) prevBtn.addEventListener('click', () => step(-1));
  if (nextBtn) nextBtn.addEventListener('click', () => step(1));
  if (replaceOneBtn) replaceOneBtn.addEventListener('click', replaceOne);
  if (replaceAllBtn) replaceAllBtn.addEventListener('click', replaceAll);

  replaceBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? step(1) : replaceOne(); }
  });
})();

/**
 * find-replace.js
 * (C) The Hyperaudio Project
 * @version 1.3.3 — last changed in release 1.3.3
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

  if (searchBox === null || toggle === null || panel === null) return;

  let matches = [];       // groups of marks: one group per phrase occurrence
  let activeIndex = -1;

  // How many spans searchPhrase marks per hit — the query's word count.
  const queryWordCount = () => {
    const words = searchBox.value.trim().split(/\s+/).filter(Boolean);
    return Math.max(1, words.length);
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
    for (let i = 0; i < flat.length; i += per) matches.push(flat.slice(i, i + per));
    if (matches.length === 0) {
      activeIndex = -1;
    } else if (!keepIndex || activeIndex < 0) {
      activeIndex = 0;
    } else if (activeIndex >= matches.length) {
      activeIndex = matches.length - 1;
    }
    renderActive();
  };

  // Run the existing search, then pick up its marks.
  const runSearch = (keepIndex) => {
    if (typeof searchPhrase === 'function') {
      searchPhrase(searchBox.value);
    }
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

  // A history restore replaces transcript.innerHTML, invalidating every mark
  // reference held in matches. Search is view state: clear its UI cache and do
  // not persist or automatically recreate highlights in the restored document.
  document.addEventListener('hyperaudioTranscriptRestored', () => {
    matches = [];
    activeIndex = -1;
    renderActive();
  });

  toggle.addEventListener('click', () => { isOpen() ? closePanel() : openPanel(); });

  // Click anywhere outside the find/replace widget closes the panel; Escape too.
  document.addEventListener('click', (e) => {
    if (isOpen() && e.target.closest && !e.target.closest('#find-replace')) closePanel();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) closePanel(); });

  // The extension already runs searchPhrase on search-box keyup; collect after
  // it so the match list and active highlight stay in sync while typing.
  searchBox.addEventListener('keyup', () => { if (isOpen()) collectMatches(false); });

  if (prevBtn) prevBtn.addEventListener('click', () => step(-1));
  if (nextBtn) nextBtn.addEventListener('click', () => step(1));
  if (replaceOneBtn) replaceOneBtn.addEventListener('click', replaceOne);
  if (replaceAllBtn) replaceAllBtn.addEventListener('click', replaceAll);

  replaceBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? step(1) : replaceOne(); }
  });
})();

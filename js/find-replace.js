/**
 * find-replace.js
 * (C) The Hyperaudio Project
 * @version 0.6.29 — last changed in release 0.6.29
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
 * and leaves the span's data-m / data-d timing intact. Works best on single
 * terms — a multi-word phrase is highlighted per word, so stepping is per word.
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

  let matches = [];       // ordered mark.search-mark elements in the transcript
  let activeIndex = -1;

  const isOpen = () => !panel.hasAttribute('hidden');

  const clearActive = () => {
    document.querySelectorAll('#hypertranscript mark.search-mark.active')
      .forEach((m) => m.classList.remove('active'));
  };

  const renderActive = () => {
    matches.forEach((m, i) => m.classList.toggle('active', i === activeIndex));
    const active = activeIndex >= 0 ? matches[activeIndex] : null;
    if (active) {
      active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    countEl.textContent = matches.length ? `${activeIndex + 1} / ${matches.length}` : '0 / 0';
    const has = matches.length > 0;
    [prevBtn, nextBtn, replaceOneBtn, replaceAllBtn].forEach((b) => {
      if (b !== null) b.disabled = !has;
    });
  };

  // Re-read the highlighted matches after a search run (or a replace).
  const collectMatches = (keepIndex) => {
    matches = Array.from(document.querySelectorAll('#hypertranscript mark.search-mark'));
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

  const replaceMark = (mark) => {
    const span = mark.closest('[data-m]') || mark.parentNode;
    mark.replaceWith(document.createTextNode(replaceBox.value));
    if (span && typeof span.normalize === 'function') span.normalize();
  };

  const replaceOne = () => {
    if (activeIndex < 0 || !matches[activeIndex]) return;
    const at = activeIndex;
    replaceMark(matches[activeIndex]);
    markDirty();
    runSearch(true);           // refresh; keep position so we land on the next hit
    if (matches.length) {
      activeIndex = Math.min(at, matches.length - 1);
      renderActive();
    }
  };

  const replaceAll = () => {
    if (matches.length === 0) return;
    matches.forEach(replaceMark);
    markDirty();
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

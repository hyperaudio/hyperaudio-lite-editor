/*
 * ============================================================================
 * PROJECT LIBRARY PANEL (#456) — the side panel over the OPFS library
 * ============================================================================
 *
 * @version 1.1.6 — last changed in release 1.1.6
 *
 * The management UX of the former Recents (#434/#435/#440), resurrected from
 * its pre-#451 history and rewired: rows list the library index that
 * hyperaudio-save.js maintains (HyperaudioSave.library), identity is the
 * generated project id, and every action is one call into that API. Starred
 * entries pin above the rest; rows order by last edit; the current project
 * carries the active highlight; the kebab menu does star/rename/duplicate/
 * delete with the armed two-step delete. Re-renders ride the
 * 'hyperaudioLibraryChanged' document event (fired locally and relayed from
 * other tabs over a BroadcastChannel), so the panel is always the index's
 * truth — including a second tab's.
 *
 * The recents-* ids/classes are kept so the pre-#451 CSS applies verbatim
 * and the mobile drawer (responsive.js) keeps working untouched.
 */

(function () {
  'use strict';

  function escapeMarkup(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const RENAME_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
  const DUPLICATE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const KEBAB_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
  const STAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  const DELETE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
  const INFO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="16" y2="12"/><line x1="12" x2="12.01" y1="8" y2="8"/></svg>';

  const lib = () => window.HyperaudioSave && window.HyperaudioSave.library;

  // seconds → "M:SS" / "H:MM:SS" for the info modal's Duration row
  function formatDuration(seconds) {
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  /* ---- Notices above the list (relocated from the legacy module): the
     delete-undo offer, and any future library problem — replaces alert() ---- */

  let noticeTimer = null;
  function showPanelNotice(message, opts) {
    opts = opts || {};
    const picker = document.querySelector('#file-picker');
    if (picker === null || picker.parentElement === null) return;
    let el = document.getElementById('recents-notice');
    if (el === null) {
      el = document.createElement('div');
      el.id = 'recents-notice';
      picker.parentElement.insertBefore(el, picker);
    }
    el.setAttribute('role', opts.tone === 'info' ? 'status' : 'alert');
    el.className = opts.tone === 'info' ? 'notice-info' : 'notice-error';
    el.textContent = '';
    el.appendChild(document.createTextNode(message));
    el.dataset.hasAction = opts.action ? 'true' : 'false';
    el.dataset.kind = opts.kind || '';
    if (opts.action) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'recents-notice-action';
      action.textContent = opts.action.label;
      action.addEventListener('click', () => { el.remove(); opts.action.handler(); });
      el.appendChild(action);
    }
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'recents-notice-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.textContent = '✕';
    dismiss.addEventListener('click', () => { el.remove(); });
    el.appendChild(dismiss);
    clearTimeout(noticeTimer);
    if (opts.sticky !== true) {
      noticeTimer = setTimeout(() => { el.remove(); }, 8000);
    }
  }

  // A GHOST notice's Restore re-homes the ON-SCREEN document; once a project
  // owns the screen again (switch, open, new transcription) that offer would
  // save the wrong content — withdraw it. The plain undo toast restores from
  // parts captured at delete time, so it is valid whoever owns the screen,
  // and stays until dismissed, clicked, or replaced.
  function hideRestoreNotice() {
    const el = document.getElementById('recents-notice');
    if (el !== null && el.dataset.kind === 'ghost') el.remove();
  }

  /* ---- Row hover popout: full name + stored summary/topics, floated to the
     RIGHT of the panel so it never covers the row or its kebab. Fixed
     position to escape the panel's scroll clip (same reasoning as the kebab
     menu below); pointer-events:none in CSS — purely informational. Skipped
     in the small-screen drawer, where there is no useful hover and no room
     beside the panel. ---- */

  const drawerQuery = window.matchMedia('(max-width: 948px)');
  let popoutEl = null;
  let popoutTimer = null;

  function hidePopout() {
    clearTimeout(popoutTimer);
    popoutTimer = null;
    if (popoutEl !== null) {
      popoutEl.remove();
      popoutEl = null;
    }
  }

  function showPopout(rowEl, entry) {
    hidePopout();
    const pane = document.getElementById('recents-pane');
    if (pane === null || !entry) return;
    popoutEl = document.createElement('div');
    popoutEl.id = 'recents-popout';
    popoutEl.setAttribute('aria-hidden', 'true'); // hover-only duplicate of kebab→Info
    const name = document.createElement('p');
    name.className = 'recents-popout-name';
    name.textContent = entry.name || 'project';
    popoutEl.appendChild(name);
    // Name and duration only: the popout is a glance, and a stored summary
    // (a real one, or the benchmark's report) swallowed the card. The full
    // summary and topics live one click away in the kebab's Info / the ⓘ.
    // glance info gained a duration line when kebab-Info went away (#480):
    // the popout is now the only at-a-distance view of a background project
    // media duration when there is media; the document's own timeline when
    // there is none (text-only imports, the benchmark)
    const glanceSeconds = (entry.media && entry.media.durationSeconds > 0)
      ? entry.media.durationSeconds
      : (entry.docDurationSeconds || 0);
    if (glanceSeconds > 0) {
      const duration = document.createElement('p');
      duration.className = 'recents-popout-topics';
      duration.textContent = 'Duration: ' + formatDuration(glanceSeconds);
      popoutEl.appendChild(duration);
    }
    document.body.appendChild(popoutEl);
    const paneRect = pane.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    popoutEl.style.left = Math.round(paneRect.right + 8) + 'px';
    const size = popoutEl.getBoundingClientRect();
    popoutEl.style.top = Math.round(Math.max(8,
      Math.min(rowRect.top, window.innerHeight - size.height - 8))) + 'px';
  }

  /* ---- Row kebab menu: one shared, fixed-position menu (#436). The list
     lives in a scroll container, so a dropdown positioned inside it would be
     clipped at the card edge for rows near the bottom — a fixed menu anchored
     to the kebab's rect behaves for every row, flipping upward near the
     viewport bottom. Closed by outside click, Escape, any scroll (the anchor
     moves), or a list re-render. ---- */

  let menuProjectId = null; // project id the open menu acts on, null when closed

  function closeMenu() {
    const menu = document.getElementById('recents-menu');
    if (menu !== null) menu.remove();
    const kebab = document.querySelector('.recents-kebab[aria-expanded="true"]');
    if (kebab !== null) kebab.setAttribute('aria-expanded', 'false');
    menuProjectId = null;
  }

  function openMenu(kebabBtn, entry) {
    closeMenu();
    hidePopout(); // one floating element at a time
    menuProjectId = entry.id;
    kebabBtn.setAttribute('aria-expanded', 'true');

    const isStarred = entry.starred === true;
    const menu = document.createElement('div');
    menu.id = 'recents-menu';
    menu.setAttribute('role', 'menu');
    // Pure file actions (#480): Info moved to the transcript card's ⓘ — the
    // other items act on the project as an object, Info inspects the content.
    // The separator fences the destructive action off from the rest.
    menu.innerHTML =
      `<button type="button" role="menuitem" class="recents-menu-star">${STAR_SVG}${isStarred ? 'Unstar' : 'Star'}</button>` +
      `<button type="button" role="menuitem" class="recents-menu-rename">${RENAME_SVG}Rename</button>` +
      `<button type="button" role="menuitem" class="recents-menu-duplicate">${DUPLICATE_SVG}Duplicate</button>` +
      '<hr class="recents-menu-sep" aria-hidden="true" />' +
      `<button type="button" role="menuitem" class="recents-menu-delete">${DELETE_SVG}Delete</button>`;
    document.body.appendChild(menu);

    const anchor = kebabBtn.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, anchor.right - size.width) + 'px';
    menu.style.top = (anchor.bottom + 4 + size.height > window.innerHeight
      ? anchor.top - size.height - 4
      : anchor.bottom + 4) + 'px';

    menu.querySelector('.recents-menu-star').addEventListener('click', () => {
      closeMenu();
      lib().setStarred(entry.id, !isStarred); // the index write re-renders us
    });
    menu.querySelector('.recents-menu-rename').addEventListener('click', () => {
      closeMenu();
      startRename(entry);
    });
    menu.querySelector('.recents-menu-duplicate').addEventListener('click', () => {
      closeMenu();
      lib().duplicate(entry.id);
    });
    // two-step delete lives inside the menu: first click arms ("Delete?"),
    // the second executes; closing the menu by any route disarms it
    const del = menu.querySelector('.recents-menu-delete');
    del.addEventListener('click', () => {
      if (del.dataset.confirming !== 'true') {
        del.dataset.confirming = 'true';
        del.classList.add('confirming');
        del.innerHTML = `${DELETE_SVG}Delete?`;
        return;
      }
      closeMenu();
      performDelete(entry);
    });

    menu.querySelector('.recents-menu-rename').focus();
  }

  /* ---- Row actions ---- */

  function findRowItem(id) {
    return [...document.querySelectorAll('#file-picker .file-item')]
      .find((el) => el.getAttribute('data-id') === id) || null;
  }

  // Swap the row label for a text input; Enter/blur commits, Escape cancels.
  // Rename is the project title Save uses — the library API updates the
  // index, the stored snapshot and (for the current project) the session.
  function startRename(entry) {
    const item = findRowItem(entry.id);
    if (item === null) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = entry.name || '';
    input.className = 'recents-rename-input';
    input.setAttribute('aria-label', 'New name');
    item.textContent = '';
    item.appendChild(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      if (commit && input.value.trim() !== '' && input.value.trim() !== entry.name) {
        lib().rename(entry.id, input.value); // index write re-renders the list
      } else {
        render(); // restore the normal row on cancel/no-op
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // The undo for deleting the CURRENT project: the document stays ON SCREEN
  // (it is the undo's raw material), and the deleted entry stays in the list
  // as a placeholder row — dotted border, greyed name, Restore and ✕ inside —
  // at the position it occupied. Restore re-homes the on-screen document
  // (edits made meanwhile included). Choosing any other project replaces the
  // screen and withdraws the offer. The ✕ finalises: it navigates to the
  // next project, because dismissing the undo while silently keeping an
  // unsaved ghost on screen would recreate the invisible-data-loss state the
  // old banner existed to warn about.
  let pendingDeleted = null; // { entry, successorId }

  async function performDelete(entry) {
    // Anchor the placeholder to the row BELOW it in its own group, captured
    // BEFORE the deletion, so it can be spliced back exactly where the row
    // was — the panel orders by last edit, and sorting the (necessarily
    // current, so most recently active) deleted entry teleported it to the top.
    const before = await lib().list();
    const group = before.filter((e) => (e.starred === true) === (entry.starred === true));
    const at = group.findIndex((e) => e.id === entry.id);
    const successorId = at !== -1 && at + 1 < group.length ? group[at + 1].id : null;
    const result = await lib().remove(entry.id);
    if (!result || result.wasCurrent !== true) return;
    pendingDeleted = { entry, successorId };
    render();
  }

  /* ---- Rendering ---- */
  /* ---- Rendering ---- */

  let renderToken = 0;

  async function render() {
    const api = lib();
    const filePicker = document.querySelector('#file-picker');
    if (!api || filePicker === null) return;
    const token = ++renderToken;
    const rows = await api.list();
    if (token !== renderToken) return; // a newer render superseded this one

    closeMenu();  // the rows it was anchored to are about to be replaced
    hidePopout(); // ditto
    filePicker.innerHTML = '';

    const currentId = api.currentId();
    if (currentId !== null) hideRestoreNotice(); // a project owns the screen again

    // any project owning the screen withdraws the offer: a switch, an open, a
    // new transcription, or Restore itself (which re-homes the ghost)
    if (pendingDeleted !== null && currentId !== null) {
      pendingDeleted = null;
    }

    // The in-progress transcription (#525): a virtual row at the top — it is
    // the newest thing happening — with a live badge. Clicking it hands the
    // screen back to the transcription; the engines' progress resumes there.
    const pending = api.pendingTranscription ? api.pendingTranscription() : null;
    if (pending !== null) {
      const nameHtml = escapeMarkup(pending.name);
      filePicker.insertAdjacentHTML('beforeend',
        `<li class="recents-row recents-row-transcribing">` +
        `<a class="file-item recents-transcribing-item">${nameHtml}` +
        `<span class="recents-transcribing-badge">transcribing…</span></a></li>`);
      filePicker.querySelector('.recents-transcribing-item')
        .addEventListener('click', (event) => {
          event.preventDefault();
          api.openPendingTranscription();
        });
    }

    const entryById = {};
    const renderRow = (entry) => {
      if (entry.deletedPlaceholder === true) {
        const nameHtml = escapeMarkup(entry.name || 'project');
        filePicker.insertAdjacentHTML('beforeend',
          `<li class="recents-row recents-row-deleted">` +
          `<span class="recents-deleted-name">${nameHtml}</span>` +
          `<span class="recents-actions">` +
          `<button type="button" class="recents-deleted-restore">Restore</button>` +
          `<button type="button" class="recents-deleted-dismiss" aria-label="Dismiss">✕</button>` +
          `</span></li>`);
        return;
      }
      entryById[entry.id] = entry;
      const idAttr = escapeMarkup(entry.id);
      const nameHtml = escapeMarkup(entry.name || 'project');
      filePicker.insertAdjacentHTML('beforeend',
        `<li class="recents-row"><a class="file-item" data-id="${idAttr}">${nameHtml}</a>` +
        `<span class="recents-actions">` +
        `<button type="button" class="recents-kebab" data-id="${idAttr}" aria-label="Options for ${nameHtml}" aria-haspopup="menu" aria-expanded="false">${KEBAB_SVG}</button>` +
        `</span></li>`);
    };

    // Starred entries pin above the rest (#440, kept for #456). With nothing
    // starred the panel keeps its static "Recents" h2 — the established
    // label, and the list really is ordered by last edit; once something is
    // starred that h2 hides and the list carries its own equal-weight
    // "Starred" / "Recents" headings instead (they scroll with the rows).
    // No "Projects" label anywhere: it's obvious these are projects.
    // Ordering within each group is unchanged (last edit).
    const starredRows = rows.filter((r) => r.starred === true);
    const recentRows = rows.filter((r) => r.starred !== true);
    if (pendingDeleted !== null) {
      const ph = Object.assign({}, pendingDeleted.entry, { deletedPlaceholder: true });
      const target = ph.starred === true ? starredRows : recentRows;
      const at = pendingDeleted.successorId !== null
        ? target.findIndex((r) => r.id === pendingDeleted.successorId) : -1;
      if (at !== -1) target.splice(at, 0, ph); else target.push(ph);
    }
    const panelTitle = document.getElementById('recents-title');
    if (panelTitle !== null) {
      panelTitle.style.display = starredRows.length > 0 ? 'none' : '';
    }
    if (starredRows.length > 0) {
      filePicker.insertAdjacentHTML('beforeend', '<li class="recents-group-heading"><h2>Starred</h2></li>');
      starredRows.forEach(renderRow);
      if (recentRows.length > 0) {
        filePicker.insertAdjacentHTML('beforeend', '<li class="recents-group-heading"><h2>Recents</h2></li>');
      }
    }
    recentRows.forEach(renderRow);

    if (rows.length === 0) {
      // opacity 0.75 (not 0.55) so the composited grey still meets the 4.5:1
      // contrast ratio on the white card (#402)
      filePicker.insertAdjacentHTML('beforeend', '<li style="padding:8px 16px; opacity:0.75">No projects yet.</li>');
    }

    const restoreBtn = filePicker.querySelector('.recents-deleted-restore');
    if (restoreBtn !== null) {
      restoreBtn.addEventListener('click', () => {
        const pending = pendingDeleted;
        pendingDeleted = null;
        if (pending !== null) {
          // pass the original ordering stamps: restored rows reappear where
          // they lived, not at the top as fresh work
          api.restoreDeleted(pending.entry.starred === true, {
            modifiedAt: pending.entry.modifiedAt,
            createdAt: pending.entry.createdAt,
          });
        }
      });
      filePicker.querySelector('.recents-deleted-dismiss').addEventListener('click', async () => {
        pendingDeleted = null;
        const remaining = await api.list();
        if (remaining.length > 0) {
          api.open(remaining[0].id); // finalise: replace the unsaved ghost
        } else {
          render(); // nothing to go to — the ghost stays, offer withdrawn
        }
      });
    }

    filePicker.querySelectorAll('.file-item').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-id') === currentId);
      el.addEventListener('click', (event) => {
        // a rename input lives inside the row's <a>; its clicks are not loads
        if (event.target.classList && event.target.classList.contains('recents-rename-input')) return;
        event.preventDefault();
        api.open(el.getAttribute('data-id')); // flushes the outgoing project itself
      });
    });
    // hover popout: attach to the ROW so it stays up while reaching for the
    // kebab (it floats clear of both); a short delay stops flicker while the
    // pointer travels down the list
    filePicker.querySelectorAll('.recents-row').forEach((li) => {
      const item = li.querySelector('.file-item');
      if (item === null) return;
      const id = item.getAttribute('data-id');
      li.addEventListener('mouseenter', () => {
        if (drawerQuery.matches || menuProjectId !== null) return;
        clearTimeout(popoutTimer);
        // a deliberate tooltip-grade dwell: browsing the list shouldn't
        // trigger it, resting on a row should
        popoutTimer = setTimeout(() => showPopout(li, entryById[id]), 1000);
      });
      li.addEventListener('mouseleave', hidePopout);
    });
    filePicker.querySelectorAll('.recents-kebab').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = btn.getAttribute('data-id');
        if (menuProjectId === id) {
          closeMenu(); // second click on the same kebab toggles it shut
          return;
        }
        openMenu(btn, entryById[id]);
      });
    });
  }

  function boot() {
    if (!window.HyperaudioSave || !window.HyperaudioSave.opfsAvailable) {
      // No OPFS, no library: leave the panel empty (the demo/session still works).
      const panelTitle = document.getElementById('recents-title');
      if (panelTitle !== null) panelTitle.style.display = 'none';
      return;
    }

    document.addEventListener('hyperaudioLibraryChanged', render);

    // Kebab menu teardown: outside click, Escape, or any scroll (the fixed
    // menu is anchored to the kebab's on-screen position, which scrolling
    // moves).
    document.addEventListener('click', (event) => {
      if (menuProjectId === null) return;
      const t = event.target;
      if (t && t.closest && (t.closest('#recents-menu') !== null || t.closest('.recents-kebab') !== null)) return;
      closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu();
    });
    document.addEventListener('scroll', () => {
      if (menuProjectId !== null) closeMenu();
      hidePopout(); // its row anchor just moved
    }, true);

    render();
  }

  /* ---- Transcript-card ⓘ (#480): Info for the CURRENT project, anchored
     top-left of the transcript card — the mirror of the copy button at
     top-right (top-right = act on the content, top-left = learn about it).
     It never switches projects: full info on a background project is the
     honest two-step — click the row, press ⓘ. Same visibility rules as the
     copy button: hidden in caption mode (view-switch wiring below) and while
     the transcript is aria-busy (CSS). ---- */

  function bootInfoButton() {
    const btn = document.createElement('button');
    btn.id = 'transcript-info-btn';
    btn.type = 'button';
    btn.className = 'btn btn-square btn-ghost btn-sm tooltip';
    btn.setAttribute('data-tip', 'Project info');
    btn.setAttribute('aria-label', 'Project info');
    btn.innerHTML = INFO_SVG;
    btn.addEventListener('click', async () => {
      const nameEl = document.getElementById('project-info-name');
      if (nameEl !== null) {
        nameEl.textContent = (window.HyperaudioSave && window.HyperaudioSave.getProjectTitle
          && window.HyperaudioSave.getProjectTitle()) || 'project';
      }
      const mediaEl = document.getElementById('project-info-media');
      if (mediaEl !== null) {
        const library = lib();
        const entry = library
          ? (await library.list()).find((e) => e.id === library.currentId())
          : undefined;
        const media = (entry && entry.media) || {};
        const rows = [];
        if (media.kind === 'original' && media.filename) rows.push(['File', media.filename]);
        if (media.kind === 'link') rows.push(['Source', 'remote URL']);
        if (media.durationSeconds > 0) rows.push(['Duration', formatDuration(media.durationSeconds)]);
        mediaEl.textContent = '';
        if (rows.length === 0) {
          const p = document.createElement('p');
          p.textContent = 'No media — text only.';
          mediaEl.appendChild(p);
        }
        rows.forEach(([label, value]) => {
          const p = document.createElement('p');
          const strong = document.createElement('strong');
          strong.textContent = label + ':';
          p.appendChild(strong);
          p.appendChild(document.createTextNode(' ' + value));
          mediaEl.appendChild(p);
        });
      }
      const toggle = document.getElementById('info-modal');
      if (toggle !== null) toggle.checked = true;
    });
    document.body.appendChild(btn);

    // the caption editor owns the card in caption mode — hide/show with the
    // view switch, covering the engines' programmatic switches too (same
    // wiring as the copy button in transcript-doc-export.js)
    const captionBtn = document.getElementById('caption-editor-btn');
    const transcriptBtn = document.getElementById('transcript-editor-btn');
    if (captionBtn !== null) {
      captionBtn.addEventListener('click', () => { btn.style.display = 'none'; });
    }
    if (transcriptBtn !== null) {
      transcriptBtn.addEventListener('click', () => { btn.style.display = ''; });
    }
  }

  function bootAll() {
    boot();
    bootInfoButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAll);
  } else {
    bootAll();
  }
})();

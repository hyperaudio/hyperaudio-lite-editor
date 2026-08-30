/*
 * ============================================================================
 * PROJECT LIBRARY PANEL (#456) — the side panel over the OPFS library
 * ============================================================================
 *
 * @version 1.3.13 — last changed in release 1.3.13
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

  /* ---- Row hover popout: full name + stored summary/topics, floated to the
     RIGHT of the panel so it never covers the row or its kebab. Fixed
     position to escape the panel's scroll clip (same reasoning as the kebab
     menu below); pointer-events:none in CSS — purely informational. Skipped
     in the small-screen drawer, where there is no useful hover and no room
     beside the panel. ---- */

  // The glyph is media-posters' (#603): the player draws the same one, and two
  // copies of a picture are two pictures waiting to diverge. Local fallbacks
  // keep the popout working if that module is absent — it is optional.
  const hashHue = (id) => (window.MediaPosters && window.MediaPosters.glyphHue)
    ? window.MediaPosters.glyphHue(id)
    : (() => { let h = 0; const s = String(id || '');
        for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360; return h; })();
  const glyphUrl = (id) => (window.MediaPosters && window.MediaPosters.glyphUrl)
    ? window.MediaPosters.glyphUrl(id)
    : null;

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
    // Poster thumbnail (#523 phase A): the stored first-frame capture when
    // media-posters has one (or the embedder provides one); a generated
    // wave glyph for audio and everything else. The async fill guards on
    // popout identity — the card may be gone before the poster arrives.
    if (entry.media && entry.media.kind !== 'none') {
      const thumb = document.createElement('div');
      thumb.className = 'recents-popout-thumb';
      thumb.style.background = 'hsl(' + hashHue(entry.id || '') + ' 30% 88%)';
      // the same picture the player shows for this project (#603), as an
      // element so the stored poster can replace it cleanly when one arrives
      const glyph = glyphUrl(entry.id || '');
      if (glyph !== null) {
        const glyphImg = document.createElement('img');
        glyphImg.className = 'recents-popout-glyph';
        glyphImg.alt = '';
        glyphImg.src = glyph;
        thumb.appendChild(glyphImg);
      }
      popoutEl.appendChild(thumb);
      const posters = window.MediaPosters;
      if (posters && typeof posters.urlFor === 'function') {
        const owner = popoutEl;
        posters.urlFor(entry.id, entry).then((url) => {
          if (url === null || popoutEl !== owner) return;
          const img = document.createElement('img');
          img.className = 'recents-popout-poster';
          img.alt = '';
          img.src = url;
          img.addEventListener('load', () => { if (popoutEl === owner) thumb.replaceChildren(img); });
        }).catch(() => {});
      }
    }
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
    popoutEl.style.left = Math.round(paneRect.right) + 'px'; // flush with the panel's right edge
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

  // The panel's visible order: the starred group, then the rest. list() sorts
  // by activity alone and knows nothing about the two headings.
  const visualOrder = (rows) =>
    rows.filter((r) => r.starred === true).concat(rows.filter((r) => r.starred !== true));

  // Deleting the CURRENT project leaves nothing owning the screen, so move to
  // its NEIGHBOUR — the row below it, or the row above when it was the last
  // one. Landing on the neighbour keeps you where you were looking; jumping
  // to the top of the list would move the ground under you as well as
  // deleting. Leaving the deleted document on screen instead is the
  // invisible-data-loss state the old banner existed to warn about: it looks
  // like an open project but owns nothing and autosaves nowhere.
  async function performDelete(entry) {
    // captured BEFORE the removal, while the neighbour's position still holds
    const before = visualOrder(await lib().list());
    const at = before.findIndex((e) => e.id === entry.id);
    const neighbour = at === -1 ? null : (before[at + 1] || before[at - 1] || null);
    const result = await lib().remove(entry.id);
    if (!result || result.wasCurrent !== true) return;
    if (neighbour !== null) {
      lib().open(neighbour.id);
    } else {
      render(); // nothing to go to — the delete still stands
    }
  }

  /* ---- Rendering ---- */
  /* ---- Rendering ---- */

  /* Host-contributed rows (#604) --------------------------------------------
   * A host may know about projects the editor does not — .hyperaudio files in
   * a folder the user chose, say. Those are the user's projects; that OPFS has
   * not seen them is an implementation detail they should not have to hold.
   * So the panel shows them, in the same division of labour as the poster
   * seam: the host owns storage, the panel owns presentation.
   *
   * Rendered as plainly NOT-yet-opened, without a kebab: rename, star and
   * delete are meaningless until the thing exists here, and opening one
   * promotes it to an ordinary project, at which point it gets all of them.
   *
   * The panel NEVER waits for the host. Its own rows are drawn first and the
   * host's are merged in when they arrive, which matters because this runs on
   * every library write — not just when Recents is opened, but after each
   * autosave. Waiting made a 1200ms host delay the active-row highlight by
   * 1216ms after a project switch: the document had already changed while the
   * list still pointed at the one you left. Nothing here gates anything, so a
   * slow host merely means its rows land a beat later, a hung one means they
   * never land, and a throwing one is indistinguishable from a host that
   * defines no hook at all.
   * ------------------------------------------------------------------------ */
  // The host's last answer, drawn immediately on the next render so the panel
  // never has to wait for it twice. Compared by signature so a stable host
  // settles after one extra render rather than looping.
  let pendingExternal = [];
  const externalSignature = (list) =>
    list.map((e) => e.id + '\u0000' + e.modifiedAt + '\u0000' + e.name).join('\u0001');

  async function externalRows(knownIds) {
    const hook = window.hyperaudioExternalProjects;
    if (typeof hook !== 'function') return [];
    let list;
    try {
      list = await hook();
    } catch (e) {
      return []; // the host's problem; the panel still has its own rows
    }
    if (!Array.isArray(list)) return [];
    return list
      .filter((e) => e && typeof e.id === 'string' && e.id !== '' && !knownIds.has(e.id))
      .map((e) => ({
        id: e.id,
        name: (typeof e.title === 'string' && e.title.trim() !== '')
          ? e.title.trim()
          : (e.mediaFilename || 'project'),
        modifiedAt: Number(e.modified) || 0,
        starred: false,
        external: true,
      }));
  }

  let renderToken = 0;

  async function render() {
    const api = lib();
    const filePicker = document.querySelector('#file-picker');
    if (!api || filePicker === null) return;
    const token = ++renderToken;
    const rows = await api.list();
    if (token !== renderToken) return; // a newer render superseded this one
    // Drawn from the last answer, never waited for (#604). A fresh ask goes out
    // below; if it differs, one more render folds it in.
    const knownIds = new Set(rows.map((r) => r.id));
    const external = pendingExternal.filter((e) => !knownIds.has(e.id));

    closeMenu();  // the rows it was anchored to are about to be replaced
    hidePopout(); // ditto
    filePicker.innerHTML = '';

    const currentId = api.currentId();

    // The in-progress transcription (#525): a virtual row at the top — it is
    // the newest thing happening — with a live badge. Clicking it hands the
    // screen back to the transcription; the engines' progress resumes there.
    const pending = api.pendingTranscription ? api.pendingTranscription() : null;
    // While the loader is what's on screen, the transcribing row is the
    // selection — from the moment the engine starts until the user moves
    // away, and again whenever they return. The project rows' own active
    // marking stands down for exactly that window (the session may still
    // point at the previous project before the birth, and its row showing
    // active while the user watches the loader would be a lie).
    const viewingPending = pending !== null && (() => {
      const t = document.getElementById('hypertranscript');
      return t !== null && t.getAttribute('aria-busy') === 'true';
    })();
    // Rendered atop the RECENTS group below (#554) — births are unstarred,
    // so that is where the finished project will land; rendered up here it
    // floated above the Starred heading whenever anything was starred.
    const renderPendingRow = () => {
      if (pending === null) return;
      const nameHtml = escapeMarkup(pending.name);
      // Same anatomy as a normal row — name column plus the actions slot —
      // so the widths line up; a spinner sits where the kebab would, saying
      // 'in progress' without words.
      filePicker.insertAdjacentHTML('beforeend',
        `<li class="recents-row recents-row-transcribing">` +
        `<a class="file-item recents-transcribing-item${viewingPending ? ' active' : ''}">${nameHtml}</a>` +
        `<span class="recents-actions">` +
        `<span class="recents-transcribing-spinner" role="img" aria-label="Transcribing"></span>` +
        `</span></li>`);
      filePicker.querySelector('.recents-transcribing-item')
        .addEventListener('click', (event) => {
          event.preventDefault();
          api.openPendingTranscription();
        });
    };

    const entryById = {};
    const renderRow = (entry) => {
      if (entry.external === true) {
        // No kebab and no data-id: this row is not a project here yet, and
        // every action in that menu would be a lie about something the editor
        // does not hold.
        const extName = escapeMarkup(entry.name || 'project');
        filePicker.insertAdjacentHTML('beforeend',
          `<li class="recents-row recents-row-external">`
          + `<a class="file-item" data-external-id="${escapeMarkup(entry.id)}">${extName}</a>`
          + `<span class="recents-actions"><span class="recents-external-badge">not opened</span></span>`
          + `</li>`);
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
    // Interleaved by last edit rather than grouped below (#604): a separate
    // block would put the two-list feel back inside one list, which is the
    // thing the seam exists to remove.
    const recentRows = rows.filter((r) => r.starred !== true).concat(external)
      .sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
    const panelTitle = document.getElementById('recents-title');
    if (panelTitle !== null) {
      panelTitle.style.display = starredRows.length > 0 ? 'none' : '';
    }
    if (starredRows.length > 0) {
      filePicker.insertAdjacentHTML('beforeend', '<li class="recents-group-heading"><h2>Starred</h2></li>');
      starredRows.forEach(renderRow);
      if (recentRows.length > 0 || pending !== null) {
        filePicker.insertAdjacentHTML('beforeend', '<li class="recents-group-heading"><h2>Recents</h2></li>');
      }
    }
    renderPendingRow();
    recentRows.forEach(renderRow);

    if (rows.length === 0 && pending === null) {
      // opacity 0.75 (not 0.55) so the composited grey still meets the 4.5:1
      // contrast ratio on the white card (#402)
      filePicker.insertAdjacentHTML('beforeend', '<li style="padding:8px 16px; opacity:0.75">No projects yet.</li>');
    }

    // Ask the host, and draw again only if the answer CHANGED. A stable host
    // therefore costs exactly one extra render the first time and none after;
    // a hung host never resolves and never triggers one.
    externalRows(knownIds).then((hostRows) => {
      if (token !== renderToken) return;
      if (externalSignature(hostRows) === externalSignature(pendingExternal)) return;
      pendingExternal = hostRows;
      render();
    }).catch(() => {});

    filePicker.querySelectorAll('.file-item[data-external-id]').forEach((el) => {
      el.addEventListener('click', (event) => {
        event.preventDefault();
        const open = window.hyperaudioOpenExternalProject;
        if (typeof open !== 'function') return; // rows with no way to open them do nothing
        try {
          Promise.resolve(open(el.getAttribute('data-external-id'))).catch((e) => {
            console.warn('[library] the host could not open an external project', e);
          });
        } catch (e) {
          console.warn('[library] the host could not open an external project', e);
        }
      });
    });

    filePicker.querySelectorAll('.file-item[data-id]').forEach((el) => {
      el.classList.toggle('active', !viewingPending && el.getAttribute('data-id') === currentId);
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

/*
 * original-media-download.js — File ▸ Download as ▸ Original media (#752)
 *
 * @version 1.3.44 — last changed in release 1.3.44
 * @license AGPL-3.0-only
 *
 * A project whose media travels inside the .hyperaudio holds the file byte
 * for byte, and had no way to give it back: Export media is a render behind
 * six choices. This item downloads the stored file under its stored name,
 * with no render. It is shown only for an open project whose media is the
 * editor's own to give (media.kind "original"), and hidden for a project
 * that plays from a link, or has none. Remove this file and the item stays
 * hidden.
 */
(function () {
  'use strict';

  const link = document.getElementById('download-original-media');
  if (link === null) return;
  const item = link.closest('li') || link;
  const submenu = document.getElementById('file-download-submenu');
  item.hidden = true;

  let current = null; // { file, filename } for the open project, or null

  async function refresh() {
    current = null;
    const save = window.HyperaudioSave;
    try {
      if (!save || typeof save.library !== 'object') return;
      const id = save.library.currentId();
      if (id === null || id === undefined) return;
      const entry = (await save.library.list()).find((p) => String(p.id) === String(id));
      const file = typeof save.sessionMediaFile === 'function' ? save.sessionMediaFile() : null;
      if (!entry || !entry.media || entry.media.kind !== 'original') return;
      if (!(file instanceof Blob) || file.size === 0) return;
      current = { file, filename: entry.media.filename || file.name || 'media' };
    } finally {
      item.hidden = current === null;
      link.setAttribute('download', current === null ? '' : current.filename);
    }
  }

  // the address is made on the way out and let go afterwards, so no object
  // URL is held for a file that is never asked for
  link.addEventListener('click', (e) => {
    if (current === null) {
      e.preventDefault();
      return;
    }
    const url = URL.createObjectURL(current.file);
    link.setAttribute('href', url);
    setTimeout(() => {
      URL.revokeObjectURL(url);
      link.setAttribute('href', '');
    }, 60000);
  }, true);

  if (submenu !== null) submenu.addEventListener('toggle', () => { if (submenu.open) refresh(); });
  document.addEventListener('hyperaudioLibraryChanged', () => { refresh(); });
  document.addEventListener('hyperaudioInit', () => { refresh(); });
  refresh();
})();

// #428 — the File menu's long "Download as" and "Export / Import" lists are
// grouped into inline-expanding submenus (DaisyUI <details>) so the menu stays
// short. This guards that the grouping didn't drop any action: every id/target
// is still present, the submenus start collapsed, and the nested label→modal
// wiring still fires after the restructure.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('long lists are grouped into collapsed submenus with every action still reachable (#428)', async ({ page }) => {
  const state = await page.evaluate(() => {
    const dl = document.getElementById('file-download-submenu');
    const im = document.getElementById('file-import-submenu');
    const ex = document.getElementById('file-export-submenu');
    const ids = ['download-vtt', 'download-vtt-words', 'download-srt', 'download-html', 'download-hypertranscript'];
    const forTargets = ['export-modal', 'interactive-export-modal', 'file-import-deepgram-json-dialog', 'file-import-srt-dialog', 'file-import-vtt-dialog'];
    const custom = ['export-json', 'export-ionosphere', 'import-json'];
    return {
      hasDownloadSubmenu: !!dl,
      hasImportSubmenu: !!im,
      hasExportSubmenu: !!ex,
      downloadStartsCollapsed: dl ? !dl.open : null,
      importStartsCollapsed: im ? !im.open : null,
      exportStartsCollapsed: ex ? !ex.open : null,
      idsPresent: ids.filter((id) => document.getElementById(id) === null),
      labelsPresent: forTargets.filter((t) => document.querySelector(`label[for="${t}"]`) === null),
      customPresent: custom.filter((tag) => document.querySelector(`#file-dropdown ${tag}`) === null),
      // the download/export/import items live UNDER their submenus (#470:
      // Import and Export are separate top-level categories)
      downloadItemsNested: !!document.querySelector('#file-download-submenu #download-vtt'),
      exportItemsNested: !!document.querySelector('#file-export-submenu export-json'),
      importItemsNested: !!document.querySelector('#file-import-submenu import-json'),
      importBeforeExport: !!(im && ex && (im.compareDocumentPosition(ex) & Node.DOCUMENT_POSITION_FOLLOWING)),
    };
  });

  expect(state.hasDownloadSubmenu).toBe(true);
  expect(state.hasImportSubmenu).toBe(true);
  expect(state.hasExportSubmenu).toBe(true);
  expect(state.downloadStartsCollapsed).toBe(true);   // collapsed → the menu is short
  expect(state.importStartsCollapsed).toBe(true);
  expect(state.exportStartsCollapsed).toBe(true);
  expect(state.idsPresent).toEqual([]);               // no download action lost
  expect(state.labelsPresent).toEqual([]);            // no modal/import target lost
  expect(state.customPresent).toEqual([]);            // custom-element exports/imports kept
  expect(state.downloadItemsNested).toBe(true);
  expect(state.exportItemsNested).toBe(true);
  expect(state.importItemsNested).toBe(true);
  expect(state.importBeforeExport).toBe(true);        // inputs above outputs (#470)
});

test('a submenu expands on click and its nested actions still fire (#428)', async ({ page }) => {
  // clicking the <summary> toggles the native <details> open
  const opened = await page.evaluate(() => {
    const d = document.getElementById('file-download-submenu');
    d.querySelector('summary').click();
    return d.open;
  });
  expect(opened).toBe(true);

  // the nested "Interactive Transcript" label still toggles its modal — proving
  // the label[for] wiring survives being moved inside the submenu
  const modalChecked = await page.evaluate(() => {
    document.getElementById('download-hypertranscript').click();
    return document.getElementById('interactive-export-modal').checked;
  });
  expect(modalChecked).toBe(true);
});

test('the menu has a real width so items are not collapsed by a purged width class (#428)', async ({ page }) => {
  // The prebuilt tailwind-min.css only ships width utilities used at build time,
  // so an unbuilt w-* class collapses the menu to content width and every item
  // wraps. Width is set inline instead; guard that the rendered menu stays wide.
  const width = await page.evaluate(() => {
    const ul = document.getElementById('file-dropdown');
    ul.closest('.dropdown').querySelector('label[tabindex="0"]').focus();
    return ul.getBoundingClientRect().width;
  });
  expect(width).toBeGreaterThanOrEqual(288);   // 18rem; the collapsed bug rendered ~160px
});

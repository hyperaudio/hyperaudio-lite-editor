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
    const ei = document.getElementById('file-exportimport-submenu');
    const ids = ['download-vtt', 'download-vtt-words', 'download-srt', 'download-html', 'download-hypertranscript'];
    const forTargets = ['export-modal', 'interactive-export-modal', 'file-import-deepgram-json-dialog', 'file-import-srt-dialog', 'file-import-vtt-dialog'];
    const custom = ['export-json', 'export-ionosphere', 'import-json'];
    return {
      hasDownloadSubmenu: !!dl,
      hasExportImportSubmenu: !!ei,
      downloadStartsCollapsed: dl ? !dl.open : null,
      exportImportStartsCollapsed: ei ? !ei.open : null,
      idsPresent: ids.filter((id) => document.getElementById(id) === null),
      labelsPresent: forTargets.filter((t) => document.querySelector(`label[for="${t}"]`) === null),
      customPresent: custom.filter((tag) => document.querySelector(`#file-dropdown ${tag}`) === null),
      // the download/export items now live UNDER the submenus, not at top level
      downloadItemsNested: !!document.querySelector('#file-download-submenu #download-vtt'),
      exportItemsNested: !!document.querySelector('#file-exportimport-submenu export-json'),
    };
  });

  expect(state.hasDownloadSubmenu).toBe(true);
  expect(state.hasExportImportSubmenu).toBe(true);
  expect(state.downloadStartsCollapsed).toBe(true);   // collapsed → the menu is short
  expect(state.exportImportStartsCollapsed).toBe(true);
  expect(state.idsPresent).toEqual([]);               // no download action lost
  expect(state.labelsPresent).toEqual([]);            // no modal/import target lost
  expect(state.customPresent).toEqual([]);            // custom-element exports/imports kept
  expect(state.downloadItemsNested).toBe(true);
  expect(state.exportItemsNested).toBe(true);
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

// The project library panel (#456; js/hyperaudio-library.js over the
// HyperaudioSave.library API). Drives the shipped editor end to end: rows
// over the OPFS index, dialog-free switching that loses nothing, star/rename/
// duplicate/delete via the kebab menu, delete-current's Restore undo, and the
// most-recently-edited boot restore.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { ladderWav, pollPage } from './helpers.mjs';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js');
const JSZip = require('jszip');

async function buildFixture(title) {
  const state = {
    generatorVersion: 'e2e',
    created: '2026-07-10T09:00:00Z',
    modified: '2026-07-10T11:30:00Z',
    media: {
      kind: 'original', path: 'media/tone.wav', url: null, filename: 'tone.wav',
      mimeType: 'audio/wav', durationSeconds: 2, sizeBytes: 0,
    },
    options: {
      gapRemoval: { enabled: false, thresholdMs: 500, bufferMs: 100 },
      updateCaptionsFromTranscript: true,
      view: { showSpeakers: true, showTimecodes: false },
    },
    texts: { title, language: 'it', summary: 'summary of ' + title, topics: [] },
    provenance: { engine: 'deepgram', model: 'model of ' + title, transcribedAt: '2026-07-10T08:55:00Z' },
    hasOriginal: false,
    transcript: {
      words: [
        { start: 0.32, end: 0.84, text: 'Benvenuti' },
        { start: 1.1, end: 1.5, text: 'a' },
      ],
      paragraphs: [{ speaker: 'Maria', start: 0.32, end: 1.5 }],
    },
  };
  return save.zipProject({
    json: save.serializeProjectJson(save.buildProjectJson(state)),
    html: '<article><section><p><span data-m="320" data-d="520">Benvenuti </span></p></section></article>',
    media: { name: 'tone.wav', data: ladderWav(2) },
  }, JSZip, 'nodebuffer');
}

// Open a titled fixture through the module's hidden input, then wait for its
// row to arrive AND become the active (current) one.
async function openProject(page, testInfo, title) {
  const fixturePath = testInfo.outputPath(title.replace(/\s+/g, '-') + '.hyperaudio');
  fs.writeFileSync(fixturePath, await buildFixture(title));
  await page.evaluate(() => { document.getElementById('project-open-input').value = ''; });
  await page.setInputFiles('#project-open-input', fixturePath);
  await expect(activeRow(page)).toHaveText(title);
}

const row = (page, title) => page.locator('#file-picker .file-item', { hasText: title });
const activeRow = (page) => page.locator('#file-picker .file-item.active');
const rowTitles = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#file-picker .file-item')].map((el) => el.textContent));

async function openKebab(page, title) {
  const item = row(page, title);
  await item.hover();
  await item.locator('..').locator('.recents-kebab').click();
  await expect(page.locator('#recents-menu')).toBeVisible();
}

const readLibraryState = (page) => page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const lib = JSON.parse(await (await (await root.getFileHandle('library.json')).getFile()).text());
  const work = await root.getDirectoryHandle('work');
  const dirs = [];
  for await (const [name, handle] of work.entries()) {
    if (handle.kind === 'directory') dirs.push(name);
  }
  return { projects: lib.projects, dirs, current: window.HyperaudioSave.library.currentId() };
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('empty library: the panel says so under its Recents heading', async ({ page }) => {
  await expect(page.locator('#recents-title')).toHaveText('Recents');
  await expect(page.locator('#file-picker')).toContainText('No projects yet.');
});

test('rows list by last edit with the current project highlighted; editing reorders', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await openProject(page, testInfo, 'Project B');
  expect(await rowTitles(page)).toEqual(['Project B', 'Project A']); // B edited (created) last

  // switch back to A — no dialog, highlight moves, order unchanged (no edit yet)
  await row(page, 'Project A').click();
  await expect(activeRow(page)).toHaveText('Project A');
  expect(await rowTitles(page)).toEqual(['Project B', 'Project A']);

  // hover reveals the full name (rows ellipsize) plus the stored preview in
  // a popout floated RIGHT of the panel — clear of the row and its kebab
  await row(page, 'Project A').hover();
  const popout = page.locator('#recents-popout');
  await expect(popout).toBeVisible();
  await expect(popout).toContainText('Project A');
  // name and duration ONLY — the stored summary lives in the Info modal, not
  // the glance (a long one, e.g. the benchmark report, swallowed the card)
  await expect(popout).not.toContainText('summary of Project A');
  expect(await page.evaluate(() => {
    const pane = document.getElementById('recents-pane').getBoundingClientRect();
    const pop = document.getElementById('recents-popout').getBoundingClientRect();
    return pop.left >= pane.right;
  })).toBe(true);
  await page.locator('#hypertranscript').hover(); // leaving the row dismisses it
  await expect(popout).toHaveCount(0);

  // an edit bumps A to the top (last-edited order)
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'EDITED-A ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#file-picker .file-item').first()).toHaveText('Project A', { timeout: 5000 });
});

test('switching flushes the outgoing project\'s pending edit — nothing lost, nothing asked (#456)', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await openProject(page, testInfo, 'Project B');
  const state = await readLibraryState(page);
  const idB = state.current;

  // edit B and switch away INSIDE the autosave debounce window
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'PENDING-B ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await row(page, 'Project A').click();
  await expect(activeRow(page)).toHaveText('Project A');
  await expect(page.locator('#hypertranscript')).not.toContainText('PENDING-B');

  // no dialog appeared, and B's directory holds the pending edit as its DRAFT
  expect(await page.evaluate(() => {
    const el = document.getElementById('project-dialog');
    return el !== null && el.classList.contains('modal-open');
  })).toBe(false);
  await pollPage(page, async (id) => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
      const text = await (await (await dir.getFileHandle('draft.json')).getFile()).text();
      return text.indexOf('PENDING-B') !== -1;
    } catch (e) { return false; }
  }, idB);

  // switching back replays the flushed edit
  await row(page, 'Project B').click();
  await expect(page.locator('#hypertranscript')).toContainText('PENDING-B');
});

test('Info is the transcript ⓘ, current project only; the kebab is pure file actions (#480)', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await openProject(page, testInfo, 'Project B'); // B is current now

  // the kebab no longer carries Info — its Info silently switched projects
  await openKebab(page, 'Project A');
  await expect(page.locator('#recents-menu .recents-menu-info')).toHaveCount(0);
  await expect(page.locator('#recents-menu .recents-menu-sep')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // full info on another project is the honest two-step: click the row…
  await row(page, 'Project A').click();
  await expect(activeRow(page)).toHaveText('Project A');
  // …then press ⓘ, which inspects the CURRENT project without any switch
  // (the handler reads the library index before opening — poll, don't peek)
  await page.locator('#transcript-info-btn').click();
  await page.waitForFunction(() => document.getElementById('info-modal').checked);
  await expect(page.locator('#project-info-name')).toHaveText('Project A');
  await expect(page.locator('#project-info-media')).toContainText('tone.wav');
  await expect(page.locator('#project-info-media')).toContainText('Duration: 0:02'); // from the index's media meta
  await expect(page.locator('#transcription-info')).toContainText('model of Project A');
  await expect(page.locator('#summary')).toContainText('summary of Project A');
  await page.evaluate(() => { document.getElementById('info-modal').checked = false; });
});

test('rename via the kebab is the title Save and Export use', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await openKebab(page, 'Project A');
  await page.locator('#recents-menu .recents-menu-rename').click();
  const input = page.locator('.recents-rename-input');
  await input.fill('Interview Final');
  await input.press('Enter');
  await expect(row(page, 'Interview Final')).toHaveCount(1);

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => document.getElementById('project-export-hyperaudio').click());
  expect((await downloadPromise).suggestedFilename()).toBe('Interview Final.hyperaudio');
});

test('a renamed project keeps its name across a switch (snapshot title rewritten)', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await openProject(page, testInfo, 'Project B');
  await openKebab(page, 'Project A'); // rename the NON-current project
  await page.locator('#recents-menu .recents-menu-rename').click();
  const input = page.locator('.recents-rename-input');
  await input.fill('Archive Cut');
  await input.press('Enter');
  await expect(row(page, 'Archive Cut')).toHaveCount(1);

  // switch to it, let its autosave run, and the name must survive (the
  // stored snapshot's title was rewritten, not just the index)
  await row(page, 'Archive Cut').click();
  await expect(activeRow(page)).toHaveText('Archive Cut');
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(2200); // outlive the debounce
  await expect(row(page, 'Archive Cut')).toHaveCount(1);
  expect(await rowTitles(page)).not.toContain('Project A');
});

test('starred projects pin above with section headings (#440 pattern)', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await openProject(page, testInfo, 'Project B');

  await openKebab(page, 'Project A');
  await expect(page.locator('#recents-menu .recents-menu-star')).toHaveText('Star');
  await page.locator('#recents-menu .recents-menu-star').click();

  // starred A pins above B despite B being edited last; the static Recents
  // h2 yields to equal-weight "Starred" / "Recents" section headings while
  // anything is starred (#440 pattern, kept for #456)
  await expect(page.locator('#file-picker .recents-group-heading h2').first()).toHaveText('Starred');
  expect(await rowTitles(page)).toEqual(['Project A', 'Project B']);
  await expect(page.locator('#recents-title')).toBeHidden();
  await expect(page.locator('#file-picker .recents-group-heading h2').nth(1)).toHaveText('Recents');

  // unstar restores the plain list under the static Recents heading
  await openKebab(page, 'Project A');
  await expect(page.locator('#recents-menu .recents-menu-star')).toHaveText('Unstar');
  await page.locator('#recents-menu .recents-menu-star').click();
  await expect(page.locator('#file-picker .recents-group-heading')).toHaveCount(0);
  await expect(page.locator('#recents-title')).toBeVisible();
});

test('duplicate makes an independent copy with its own directory', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await openKebab(page, 'Project A');
  await page.locator('#recents-menu .recents-menu-duplicate').click();
  await expect(row(page, 'Project A copy')).toHaveCount(1);

  const state = await readLibraryState(page);
  expect(state.projects.length).toBe(2);
  expect(state.dirs.length).toBe(2);
  const copy = state.projects.find((p) => p.name === 'Project A copy');
  expect(copy.id).not.toBe(state.current);    // the copy is not the current project
  expect(save.isEntryDirty(copy)).toBe(false); // it mirrors its clean (opened) source

  // the copy's saved state carries its own title and the media came along
  const copyFiles = await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
    const snapshot = JSON.parse(await (await (await dir.getFileHandle('saved.json')).getFile()).text());
    const media = await (await dir.getDirectoryHandle('media')).getFileHandle('tone.wav');
    return { title: JSON.parse(snapshot.json).texts.title, media: media.name };
  }, copy.id);
  expect(copyFiles.title).toBe('Project A copy');
  expect(copyFiles.media).toBe('tone.wav');
});

test('delete is a two-step arm inside the menu; a non-current project just goes', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await openProject(page, testInfo, 'Project B');

  await openKebab(page, 'Project A');
  const del = page.locator('#recents-menu .recents-menu-delete');
  await del.click();
  await expect(del).toHaveText(/Delete\?/); // armed, not executed
  await expect(row(page, 'Project A')).toHaveCount(1);
  await del.click();

  await expect(row(page, 'Project A')).toHaveCount(0);
  await expect(page.locator('#recents-notice')).toHaveCount(0); // no undo offer: it wasn't current
  const state = await readLibraryState(page);
  expect(state.projects.length).toBe(1);
  expect(state.dirs.length).toBe(1); // the directory went with the entry
});

test('deleting the LAST project keeps it on screen and Restore re-homes it', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  const before = await readLibraryState(page);

  await openKebab(page, 'Project A');
  const del = page.locator('#recents-menu .recents-menu-delete');
  await del.click();
  await del.click();

  // gone from the library, still on screen, undo offered
  await expect(row(page, 'Project A')).toHaveCount(0);
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  await expect(page.locator('#recents-notice')).toContainText('no longer being saved');

  await page.locator('#recents-notice .recents-notice-action').click();
  await expect(activeRow(page)).toHaveText('Project A');
  const after = await readLibraryState(page);
  expect(after.projects.length).toBe(1);
  expect(after.current).not.toBe(before.current); // re-homed under a fresh id
  expect(after.dirs).toEqual([after.current]);

  // and the re-homed project autosaves again
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'RESTORED ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pollPage(page, async (id) => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
      const text = await (await (await dir.getFileHandle('draft.json')).getFile()).text();
      return text.indexOf('RESTORED') !== -1;
    } catch (e) { return false; }
  }, after.current);
});

test('deleting the current project navigates to the next; Restore rebuilds it (#456 revisited)', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await openProject(page, testInfo, 'Project B');
  await expect(activeRow(page)).toHaveText('Project B');

  await openKebab(page, 'Project B');
  const del = page.locator('#recents-menu .recents-menu-delete');
  await del.click();
  await del.click();

  // like closing a tab: landed on the other project, no ghost, no lecture —
  // the deleted entry stays in the list as a dotted placeholder carrying its
  // own Restore and dismiss
  await expect(activeRow(page)).toHaveText('Project A');
  await expect(row(page, 'Project B')).toHaveCount(0);
  const placeholder = page.locator('.recents-row-deleted');
  await expect(placeholder).toHaveCount(1);
  await expect(placeholder).toContainText('Project B');

  // the placeholder survives re-renders while we stay on the landing project
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('hyperaudioLibraryChanged')));
  await expect(page.locator('.recents-row-deleted .recents-deleted-restore')).toBeVisible();

  // Restore rebuilds the deleted project from its captured parts
  await page.locator('.recents-row-deleted .recents-deleted-restore').click();
  await expect(activeRow(page)).toHaveText('Project B');
  const state = await readLibraryState(page);
  expect(state.projects.length).toBe(2);
  expect(state.dirs).toContain(state.current);
  await expect(page.locator('.recents-row-deleted')).toHaveCount(0); // offer consumed
});

test('navigating to another project withdraws the deleted placeholder', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await openProject(page, testInfo, 'Project B');
  await openProject(page, testInfo, 'Project C');

  await openKebab(page, 'Project C'); // current
  const del = page.locator('#recents-menu .recents-menu-delete');
  await del.click();
  await del.click();
  await expect(page.locator('.recents-row-deleted')).toHaveCount(1);

  // the placeholder sits WHERE THE ROW WAS — immediately above its old
  // successor — not teleported to the top by activity sorting
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('#file-picker .recents-row')].map((li) =>
      li.classList.contains('recents-row-deleted')
        ? 'PLACEHOLDER:' + li.querySelector('.recents-deleted-name').textContent
        : li.querySelector('.file-item').textContent));
  const at = names.findIndex((n) => n.startsWith('PLACEHOLDER:'));
  expect(names[at]).toBe('PLACEHOLDER:Project C');
  expect(names[at + 1]).toBe('Project B'); // its successor at delete time

  // one row, same footprint as a real row, controls visible without hover
  const geometry = await page.evaluate(() => {
    const ph = document.querySelector('.recents-row-deleted');
    const real = document.querySelector('.recents-row:not(.recents-row-deleted)');
    const restore = ph.querySelector('.recents-deleted-restore');
    return {
      sameHeight: Math.abs(ph.getBoundingClientRect().height - real.getBoundingClientRect().height) <= 6,
      oneLine: ph.getBoundingClientRect().height < 2 * real.getBoundingClientRect().height,
      sameWidth: Math.abs(ph.getBoundingClientRect().width - real.getBoundingClientRect().width) <= 2,
      restoreVisible: getComputedStyle(restore).opacity !== '0'
        && getComputedStyle(restore.parentElement).opacity !== '0',
    };
  });
  expect(geometry).toEqual({ sameHeight: true, oneLine: true, sameWidth: true, restoreVisible: true });

  // any navigation elsewhere withdraws the offer
  await row(page, 'Project A').click();
  await expect(activeRow(page)).toHaveText('Project A');
  await expect(page.locator('.recents-row-deleted')).toHaveCount(0);
  await expect(row(page, 'Project C')).toHaveCount(0); // gone for good
});

test('boot restores the project you were last ON, not the last written', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await openProject(page, testInfo, 'Project B');

  // Edit A, then switch to B and leave it alone. A is the most recently
  // WRITTEN (its draft flushes on the way out), B is the one being looked at.
  await row(page, 'Project A').click();
  await expect(activeRow(page)).toHaveText('Project A');
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'LAST-EDIT ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const idA = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await pollPage(page, async (id) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
    try {
      const text = await (await (await dir.getFileHandle('draft.json')).getFile()).text();
      return text.indexOf('LAST-EDIT') !== -1;
    } catch (e) { return false; }
  }, idA);

  await row(page, 'Project B').click();
  await expect(activeRow(page)).toHaveText('Project B');
  await pollPage(page, async () => {
    const root = await navigator.storage.getDirectory();
    const lib = JSON.parse(await (await (await root.getFileHandle('library.json')).getFile()).text());
    const id = window.HyperaudioSave.library.currentId();
    const b = lib.projects.find((p) => p.id === id);
    return !!(b && b.lastActiveAt);
  });

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect(activeRow(page)).toHaveText('Project B');
});

test('a library written before lastActiveAt still boots to its newest entry', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await openProject(page, testInfo, 'Project B');

  // strip the field, as an existing user's library has it
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('library.json');
    const lib = JSON.parse(await (await handle.getFile()).text());
    lib.projects.forEach((p) => { delete p.lastActiveAt; });
    const w = await handle.createWritable();
    await w.write(JSON.stringify(lib));
    await w.close();
  });

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  // falls back to modifiedAt — B was opened last, so it is the newest write
  await expect(activeRow(page)).toHaveText('Project B');
});

test('reload never flashes the demo transcript over a saved project (#473)', async ({ page }, testInfo) => {
  await openProject(page, testInfo, 'Project A');
  await pollPage(page, () => localStorage.getItem('hyperaudioHasProjects') === '1');

  // watch every frame from before the first page script: count frames where
  // the demo ([Monika]) was VISIBLE; stop once the project content lands
  await page.addInitScript(() => {
    window.__demoFlashFrames = 0;
    const tick = () => {
      const el = document.querySelector('#hypertranscript');
      if (el !== null && el.textContent.indexOf('Benvenuti') !== -1) return; // project landed
      if (el !== null && el.textContent.indexOf('[Monika]') !== -1
          && getComputedStyle(el).visibility !== 'hidden') {
        window.__demoFlashFrames += 1;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.reload();
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  expect(await page.evaluate(() => window.__demoFlashFrames)).toBe(0);
  // the anti-flash hide is down again (reveal ran)
  expect(await page.evaluate(() =>
    document.documentElement.classList.contains('ha-restoring'))).toBe(false);
});

test('the has-projects hint tracks the library (#473)', async ({ page }, testInfo) => {
  // empty library: boot self-heals the hint away
  expect(await page.evaluate(() => localStorage.getItem('hyperaudioHasProjects'))).toBeNull();
  await openProject(page, testInfo, 'Project A');
  await pollPage(page, () => localStorage.getItem('hyperaudioHasProjects') === '1');
  // deleting the last project retires the hint — no phantom hide next boot
  await openKebab(page, 'Project A');
  const del = page.locator('#recents-menu .recents-menu-delete');
  await del.click();
  await del.click();
  await pollPage(page, () => localStorage.getItem('hyperaudioHasProjects') === null);
});

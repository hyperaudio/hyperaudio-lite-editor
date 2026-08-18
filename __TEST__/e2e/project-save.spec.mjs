// .hyperaudio project save/open (js/hyperaudio-save.js; spec: docs/format/).
// Drives the shipped editor end to end: opens a conformant container built
// with the module's own pure layers, checks that transcript (redactions
// included), captions, options and texts land in the editor; downloads a save
// and verifies the container; reloads and checks the OPFS working-copy restore.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { ladderWav, pollPage } from './helpers.mjs';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js');
const JSZip = require('jszip');

const FIXTURE_VTT = 'WEBVTT\n\n00:00:00.320 --> 00:00:01.500\nBenvenuti a Hyperaudio\n';

// mutateJson lets a test write a container the WRITER can no longer produce —
// e.g. paragraphs: [], which buildProjectJson now normalises away (#492) but
// files predating the rule still carry, and readers must still tolerate.
async function buildFixture(mutateJson, captionsVtt, mediaSeconds) {
  const state = {
    generatorVersion: 'e2e',
    created: '2026-07-10T09:00:00Z',
    modified: '2026-07-10T11:30:00Z',
    media: {
      kind: 'original', path: 'media/tone.wav', url: null, filename: 'tone.wav',
      mimeType: 'audio/wav', durationSeconds: 2, sizeBytes: 0,
    },
    options: {
      gapRemoval: { enabled: true, thresholdMs: 700, bufferMs: 150 },
      updateCaptionsFromTranscript: false,
      view: { showSpeakers: true, showTimecodes: false },
    },
    texts: { title: 'E2E Project', language: 'it', summary: 'summary text', topics: ['e2e'] },
    provenance: { engine: 'deepgram', model: 'nova-3', transcribedAt: '2026-07-10T08:55:00Z' },
    hasOriginal: true,
    transcript: {
      words: [
        { start: 0.32, end: 0.84, text: 'Benvenuti' },
        { start: 0.84, end: 1.02, text: 'ehm', struck: true },
        { start: 1.1, end: 1.5, text: 'a' },
      ],
      paragraphs: [{ speaker: 'Maria', start: 0.32, end: 1.5 }],
    },
  };
  const project = save.buildProjectJson(state);
  if (typeof mutateJson === 'function') mutateJson(project);
  return save.zipProject({
    json: save.serializeProjectJson(project),
    html: '<article><section><p><span data-m="320" data-d="520">Benvenuti </span></p></section></article>',
    originalJson: JSON.stringify({ words: [{ start: 0.32, end: 0.84, text: 'benvenuti' }], paragraphs: [] }),
    captionsVtt: captionsVtt || FIXTURE_VTT,
    media: { name: 'tone.wav', data: ladderWav(mediaSeconds || 2) },
  }, JSZip, 'nodebuffer');
}

// Open the fixture in the live page via the module's hidden input; collect any
// native dialogs (a conformant open must produce none).
async function openFixture(page, testInfo, dialogs, mutateJson, captionsVtt, mediaSeconds) {
  const fixturePath = testInfo.outputPath('fixture.hyperaudio');
  fs.writeFileSync(fixturePath, await buildFixture(mutateJson, captionsVtt, mediaSeconds));
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    dialog.accept();
  });
  await page.setInputFiles('#project-open-input', fixturePath);
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
}

// The module's designed dialog (replaces native alert/confirm): its visible
// message text, or null when closed.
const projectModal = (page) => page.evaluate(() => {
  const el = document.getElementById('project-dialog');
  return el !== null && el.classList.contains('modal-open')
    ? el.querySelector('#project-dialog-message').textContent
    : null;
});
const awaitModal = (page) => page.waitForFunction(() => {
  const el = document.getElementById('project-dialog');
  return el !== null && el.classList.contains('modal-open');
});

// The library index (#456) replaced the localStorage boot hint: "the working
// copy landed" now means the current project has an entry in library.json.
const awaitLibraryEntry = (page) => pollPage(page, async () => {
  try {
    const root = await navigator.storage.getDirectory();
    const text = await (await (await root.getFileHandle('library.json')).getFile()).text();
    return JSON.parse(text).projects.length > 0
      && window.HyperaudioSave.library.currentId() !== null;
  } catch (e) {
    return false;
  }
});

// The current project's index entry and per-project working state — the
// draft (unsaved edits) when one exists, else the saved state (#456).
const readCurrentProject = (page) => page.evaluate(async () => {
  const id = window.HyperaudioSave.library.currentId();
  const root = await navigator.storage.getDirectory();
  const lib = JSON.parse(await (await (await root.getFileHandle('library.json')).getFile()).text());
  const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
  const readState = async (name) => {
    try { return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()); }
    catch (e) { return null; }
  };
  const draft = await readState('draft.json');
  const saved = await readState('saved.json');
  return { id, entry: lib.projects.find((p) => p.id === id), snapshot: draft || saved, draft, saved };
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('save button, import menu item, and hidden input are injected', async ({ page }) => {
  // Save lives in the navbar (primary, before the export button), not the menu
  await expect(page.locator('#project-save-btn')).toHaveCount(1);
  const order = await page.evaluate(() => {
    const btn = document.getElementById('project-save-btn');
    return btn.nextElementSibling && btn.nextElementSibling.id;
  });
  expect(order).toBe('export-media-btn');
  // labels carry no verb: the submenu category (Import/Export) does (#470)
  await expect(page.locator('#file-import-submenu #project-open-hyperaudio')).toHaveText('Project (.hyperaudio)');
  await expect(page.locator('#file-export-submenu #project-export-hyperaudio')).toHaveText('Project (.hyperaudio)');
  await expect(page.locator('#project-open-input')).toHaveCount(1);
});

test('opening a .hyperaudio lands transcript, redaction, captions, options and texts', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);

  // transcript: words as spans, the redacted word struck out
  const struck = page.locator('#hypertranscript span[data-m="840"]');
  await expect(struck).toHaveText('ehm ');
  await expect(struck).toHaveCSS('text-decoration-line', 'line-through');
  await expect(page.locator('#hypertranscript .speaker')).toHaveText('[Maria] ');

  // media: playing from the embedded file (object URL, not the demo source)
  const src = await page.evaluate(() => document.querySelector('#hyperplayer').src);
  expect(src).toMatch(/^blob:/);

  // captions: the saved VTT is on the track (curated — updateFromTranscript false)
  const trackSrc = await page.evaluate(() => document.querySelector('#hyperplayer-vtt').src);
  expect(decodeURIComponent(trackSrc.split(',')[1])).toContain('Benvenuti a Hyperaudio');

  // options and texts (the title has no UI field until #449 — it lives in the
  // session and is asserted through the save round-trip in the next test)
  await expect(page.locator('#remove-gaps-enabled')).toBeChecked();
  await expect(page.locator('#remove-gaps-threshold')).toHaveValue('700');
  await expect(page.locator('#summary')).toHaveText('summary text');

  expect(dialogs).toEqual([]); // a conformant file opens without any alert
});

test('Export Project downloads a conformant container that round-trips (#456)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => document.getElementById('project-export-hyperaudio').click());
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('E2E Project.hyperaudio');

  const savedPath = testInfo.outputPath('saved.hyperaudio');
  await download.saveAs(savedPath);
  const buf = fs.readFileSync(savedPath);

  // mimetype-first convention: the MIME type is readable at byte offset 38
  expect(buf.toString('ascii', 30, 38)).toBe('mimetype');
  expect(buf.toString('utf8', 38, 38 + save.CONTAINER_MIMETYPE.length)).toBe(save.CONTAINER_MIMETYPE);

  const loaded = await save.unzipProject(new Uint8Array(buf), JSZip);
  expect(loaded.recovered).toBe(false);
  expect(loaded.project.texts.title).toBe('E2E Project');
  expect(loaded.project.media.filename).toBe('tone.wav');
  expect(loaded.mediaData.length).toBeGreaterThan(1000);
  // the redaction survived the full editor round-trip
  expect(loaded.project.transcript.words.some((w) => w.text === 'ehm' && w.struck === true)).toBe(true);
  // the speaker survived it too — as a paragraph name, never as a fake word
  // (the gather-side class strip used to demote "[Maria]" to a word, #456)
  expect(loaded.project.transcript.paragraphs[0].speaker).toBe('Maria');
  expect(loaded.project.transcript.words.some((w) => w.text.includes('[Maria]'))).toBe(false);
  // the origin travelled along, untouched and struck-free
  expect(JSON.parse(loaded.originalText).words[0].text).toBe('benvenuti');
  expect(loaded.captionsVtt).toContain('Benvenuti a Hyperaudio');
  expect(loaded.project.provenance.originalTranscript).toBe('transcript.original.json');
});

test('the working copy survives a reload (OPFS restore)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);

  // the open seeds a project dir and its library entry (#456)
  await awaitLibraryEntry(page);

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');

  // the restored project replaces the static demo transcript
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  await expect(page.locator('#hypertranscript span[data-m="840"]')).toHaveCSS('text-decoration-line', 'line-through');
  // the speaker label restores WITH its class (styling + Speakers toggle)
  await expect(page.locator('#hypertranscript .speaker')).toHaveText('[Maria] ');
  await expect(page.locator('#remove-gaps-threshold')).toHaveValue('700');
  const src = await page.evaluate(() => document.querySelector('#hyperplayer').src);
  expect(src).toMatch(/^blob:/);

  // the project title survived the restore in the session (no UI field until
  // #449): an export after reload still suggests the title-derived filename
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => document.getElementById('project-export-hyperaudio').click());
  expect((await downloadPromise).suggestedFilename()).toBe('E2E Project.hyperaudio');
});

test('opening while dirty asks nothing: the pending edit flushes to its own project (#456)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  const first = await readCurrentProject(page);
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'DIRTY ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // re-open the fixture over the dirty project — the discard dialog is gone:
  // the outgoing project keeps its edits in its own directory and the open
  // simply makes a second library entry
  await page.evaluate(() => { document.getElementById('project-open-input').value = ''; });
  const fixturePath = testInfo.outputPath('fixture.hyperaudio');
  await page.setInputFiles('#project-open-input', fixturePath);
  await expect(page.locator('#hypertranscript')).not.toContainText('DIRTY');
  expect(await projectModal(page)).toBeNull(); // switching asks nothing
  expect(dialogs).toEqual([]);

  await pollPage(page, async (firstId) => {
    try {
      const root = await navigator.storage.getDirectory();
      const lib = JSON.parse(await (await (await root.getFileHandle('library.json')).getFile()).text());
      if (lib.projects.length !== 2) return false;
      const work = await root.getDirectoryHandle('work');
      // the outgoing project's pending edit flushed to ITS OWN DRAFT…
      await (await work.getDirectoryHandle(firstId)).getFileHandle('draft.json');
      // …and the opened project seeded its saved state
      const current = window.HyperaudioSave.library.currentId();
      await (await work.getDirectoryHandle(current)).getFileHandle('saved.json');
      return true;
    } catch (e) {
      return false;
    }
  }, first.id);
  const state = await page.evaluate(async (firstId) => {
    const root = await navigator.storage.getDirectory();
    const lib = JSON.parse(await (await (await root.getFileHandle('library.json')).getFile()).text());
    const work = await root.getDirectoryHandle('work');
    const dir = await work.getDirectoryHandle(firstId);
    const draft = JSON.parse(await (await (await dir.getFileHandle('draft.json')).getFile()).text());
    return {
      count: lib.projects.length,
      current: window.HyperaudioSave.library.currentId(),
      firstHtml: draft.html,
      firstEntry: lib.projects.find((p) => p.id === firstId),
    };
  }, first.id);
  expect(state.count).toBe(2);              // re-opening made a second entry
  expect(state.current).not.toBe(first.id); // …which now owns the editor
  expect(state.firstHtml).toContain('DIRTY'); // nothing was lost
  expect(save.isEntryDirty(state.firstEntry)).toBe(true); // and it stays honestly dirty
});

test('an unopenable file is refused with the designed modal, project untouched', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  // dirty the project so an accidental switch/replace would be observable
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'EDITED ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(2000); // let the autosave land (dirty = work > download)

  // a non-conforming container: compressed media entry
  const badPath = testInfo.outputPath('bad.hyperaudio');
  const JSZipLocal = new JSZip();
  const buf = await buildFixture();
  const src = await JSZip.loadAsync(buf);
  for (const name of Object.keys(src.files)) {
    if (src.files[name].dir) continue;
    const data = await src.files[name].async('uint8array');
    JSZipLocal.file(name, data, name.startsWith('media/')
      ? { compression: 'DEFLATE' }
      : { compression: name === 'mimetype' ? 'STORE' : 'DEFLATE' });
  }
  fs.writeFileSync(badPath, await JSZipLocal.generateAsync({ type: 'nodebuffer' }));

  await page.evaluate(() => { document.getElementById('project-open-input').value = ''; });
  await page.setInputFiles('#project-open-input', badPath);
  await awaitModal(page);

  // the refusal — designed modal, no native dialog, never the replace-question
  expect(dialogs).toEqual([]);
  const text = await projectModal(page);
  expect(text).toContain('media compressed');
  expect(text).not.toContain('REPLACE');
  await page.click('#project-dialog-confirm');
  expect(await projectModal(page)).toBeNull();
  // and the dirty project is untouched
  await expect(page.locator('#hypertranscript')).toContainText('EDITED');
});

test('edit tracking survives the caption-mode round trip (#448 delegation)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);

  // the round trip that REPLACES #hypertranscript — direct listeners died here
  await page.click('#caption-editor-btn');
  await page.waitForTimeout(400);
  // curated captions raise the divergence notice on entry (#506) — dismiss
  const divergence = page.locator('#project-dialog.modal-open');
  if (await divergence.isVisible()) await page.click('#project-dialog-confirm');
  await page.click('#transcript-editor-btn');
  await page.waitForTimeout(400);

  const before = (await readCurrentProject(page)).entry.lastDraftAt || 0;

  // an edit on the REPLACED transcript element must still reach the autosave
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'POST-ROUNDTRIP ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(2500);

  const after = await readCurrentProject(page);
  expect(after.entry.lastDraftAt).toBeGreaterThan(before);
  expect(after.draft.html).toContain('POST-ROUNDTRIP');
});

test('a fresh transcription births CLEAN: the engine caption pass is not an edit', async ({ page }) => {
  // simulate exactly what every engine does when a transcription lands:
  // render the transcript, fire hyperaudioInit, then the caption event
  await page.evaluate(() => {
    document.getElementById('hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">Fresh </span><span data-m="500" data-d="500">words </span></p></section></article>';
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  });
  await awaitLibraryEntry(page);
  // the birth commit gathers AFTER the captions are generated, so the
  // committed v0 matches the screen — the Save button must be clean
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);
  await page.waitForTimeout(2000); // and it stays clean once the birth settles
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  // focus traffic is not an edit: focus into the transcript and away again —
  // the same sequence an app switch replays on window refocus — stays clean
  await page.evaluate(() => {
    document.getElementById('hypertranscript').focus();
    document.getElementById('project-save-btn').focus();
  });
  await page.waitForTimeout(300);
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  // a LATER caption regeneration (user-driven) is a real edit again
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  });
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);
});

test('Save is a SILENT OPFS commit: dot clears, saved.json lands, the draft retires (#456)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  await expect(page.locator('#project-save-btn')).toHaveCount(1);
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'COMMITTED ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);

  // no download listener here on purpose: a Save must not download anything
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.click('#project-save-btn');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  const state = await readCurrentProject(page);
  expect(state.saved.html).toContain('COMMITTED'); // the commit holds the edit
  expect(state.draft).toBeNull();                  // the draft died with the save
  expect(save.isEntryDirty(state.entry)).toBe(false);
  expect(downloaded).toBe(false);
  expect(dialogs).toEqual([]);
});

test('Ctrl/⌘-S is the same silent save (#449/#456)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'KEYBOARD ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);
  await page.keyboard.press('Control+s');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);
  expect((await readCurrentProject(page)).saved.html).toContain('KEYBOARD');
});

test('the native bridge intercepts the save instead of a download (#449)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await page.evaluate(() => {
    window.__bridgeSaved = null;
    window.hyperaudioProjectBridge = {
      save(blob, name) { window.__bridgeSaved = { size: blob.size, name }; return true; },
    };
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'BRIDGED ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#project-save-btn');
  await page.waitForFunction(() => window.__bridgeSaved !== null);
  const saved = await page.evaluate(() => window.__bridgeSaved);
  expect(saved.name).toBe('E2E Project.hyperaudio');
  expect(saved.size).toBeGreaterThan(1000);
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/); // bridge save marks clean
});

test('closing loses nothing: unsaved edits ride the draft across a reload, still dirty (#456)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  const armed = () => page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });

  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'UNSAVED ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // dirty, but the draft persists — so the quit guard must NOT nag (#456:
  // it arms only for a deleted-but-on-screen document with no home)
  expect(await armed()).toBe(false);

  // let the draft land, then reload: the edit survives WITH its dirty state
  await pollPage(page, async () => {
    const id = window.HyperaudioSave.library.currentId();
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
      const text = await (await (await dir.getFileHandle('draft.json')).getFile()).text();
      return text.indexOf('UNSAVED') !== -1;
    } catch (e) { return false; }
  });
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect(page.locator('#hypertranscript')).toContainText('UNSAVED');
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);

  // a Save commits it: clean across the NEXT reload too, from saved.json
  await page.click('#project-save-btn');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect(page.locator('#hypertranscript')).toContainText('UNSAVED');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);
});

test('a second tab on the SAME project is guarded: banner, no writes, promotion on owner close (#450/#456)', async ({ page, context }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs); // tab 1 owns the project
  await awaitLibraryEntry(page);
  const owner = await readCurrentProject(page);
  // the guarded tab's edits must never write the owner's directory: no
  // draft.json may appear there, and saved.json must stay byte-identical
  const readOwnerState = () => page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
    const saved = await (await (await dir.getFileHandle('saved.json')).getFile()).text();
    let hasDraft = true;
    try { await dir.getFileHandle('draft.json'); } catch (e) { hasDraft = false; }
    return { saved, hasDraft };
  }, owner.id);
  const ownerState = await readOwnerState();
  expect(ownerState.hasDraft).toBe(false);

  // tab 2 boots onto the same most-recent project: on screen and editable,
  // but bannered — its edits must NOT reach the owner's working copy
  const page2 = await context.newPage();
  await page2.goto('/index.html');
  await page2.waitForSelector('#hypertranscript [data-m]');
  await expect(page2.locator('#tab-guard-banner')).toBeVisible();
  await expect(page2.locator('#hypertranscript')).toContainText('Benvenuti');

  await page2.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'TAB-TWO ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page2.waitForTimeout(2200); // outlive the autosave debounce
  const untouched = await readOwnerState();
  expect(untouched.hasDraft).toBe(false); // tab 2's edit never reached the working copy
  expect(untouched.saved).toBe(ownerState.saved);

  // owner closes → tab 2 is promoted: banner drops, its autosave now lands
  await page.close();
  await expect(page2.locator('#tab-guard-banner')).toHaveCount(0);
  await page2.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pollPage(page2, async (id) => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
      const text = await (await (await dir.getFileHandle('draft.json')).getFile()).text();
      return text.indexOf('TAB-TWO') !== -1;
    } catch (e) { return false; }
  }, owner.id);
  await page2.close();
});

test('two tabs edit two DIFFERENT projects, each owning its own working copy (#456)', async ({ page, context }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs); // tab 1: project one
  await awaitLibraryEntry(page);
  const owner = await readCurrentProject(page);

  const page2 = await context.newPage();
  await page2.goto('/index.html');
  await page2.waitForSelector('#hypertranscript [data-m]');
  await expect(page2.locator('#tab-guard-banner')).toBeVisible(); // same project at boot

  // a new transcription in tab 2 becomes its OWN project: banner drops
  await page2.evaluate(() => {
    document.querySelector('#hyperplayer').src = 'https://example.com/media/tab2.mp4';
    document.querySelector('#hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">TAB-TWO </span></p></section></article>';
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  });
  await expect(page2.locator('#tab-guard-banner')).toHaveCount(0);
  await page2.waitForFunction((ownerId) => {
    const id = window.HyperaudioSave.library.currentId();
    return id !== null && id !== ownerId;
  }, owner.id);

  // both tabs write their own directories; the shared index lists both
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'TAB-ONE ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(2200);
  const state = await page2.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const lib = JSON.parse(await (await (await root.getFileHandle('library.json')).getFile()).text());
    const work = await root.getDirectoryHandle('work');
    const html = {};
    for (const p of lib.projects) {
      const dir = await work.getDirectoryHandle(p.id);
      let text = null;
      try { text = await (await (await dir.getFileHandle('draft.json')).getFile()).text(); }
      catch (e) { text = await (await (await dir.getFileHandle('saved.json')).getFile()).text(); }
      html[p.id] = JSON.parse(text).html;
    }
    return { count: lib.projects.length, current: window.HyperaudioSave.library.currentId(), html };
  });
  expect(state.count).toBe(2);
  expect(state.html[owner.id]).toContain('TAB-ONE');
  expect(state.html[state.current]).toContain('TAB-TWO');
  await page2.close();
});

test('a fresh transcription starts CLEAN: v0 committed at birth, dirty only on edit', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelector('#hyperplayer').src = 'https://example.com/media/fresh.mp4';
    document.querySelector('#hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">Fresh </span></p></section></article>';
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  });
  await pollPage(page, async () => {
    const id = window.HyperaudioSave.library.currentId();
    if (id === null) return false;
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
      await dir.getFileHandle('saved.json'); // v0 committed at birth
      return true;
    } catch (e) { return false; }
  });

  const state = await readCurrentProject(page);
  expect(state.saved.html).toContain('Fresh');
  expect(state.draft).toBeNull();                     // no draft at birth
  expect(save.isEntryDirty(state.entry)).toBe(false); // clean until edited
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  // the first real edit flips it dirty, as always
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'Edited ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);
});

test('the tab-guard banner is dismissible (per appearance, no persistence)', async ({ page, context }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);

  const page2 = await context.newPage();
  await page2.goto('/index.html');
  await page2.waitForSelector('#hypertranscript [data-m]');
  await expect(page2.locator('#tab-guard-banner')).toBeVisible();

  await page2.click('#tab-guard-banner button[aria-label="Dismiss"]');
  await expect(page2.locator('#tab-guard-banner')).toHaveCount(0);
  await page2.close();
});

// #486: the writer used to ship the live DOM's editing noise into
// transcript.html. Searching wraps matches in <mark class="search-mark"> inside
// the word spans, and a save taken while that highlight was up persisted the
// marks — § 4 defines the entry as one <span> per word. The saved HTML must
// contain word spans and nothing else, whatever the DOM currently holds.
test('the saved transcript.html carries no markup but word spans (#486)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);

  // dirty the document, then raise a search highlight over it
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'HIGHLIGHTED ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // per-character typing: the vendored search runs on keyup, so fill() alone
  // sets the value without ever triggering it
  await page.locator('#search-box').pressSequentially('HIGH');
  await expect(page.locator('#hypertranscript mark.search-mark')).not.toHaveCount(0);

  await page.keyboard.press('Control+s');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  const html = (await readCurrentProject(page)).saved.html;
  expect(html).toContain('HIGHLIGHTED');   // the word survives, as text
  expect(html).not.toContain('<mark');     // the highlight does not

  // nothing but <article>/<section>/<p>/<span> in the persisted markup
  const tags = [...html.matchAll(/<([a-zA-Z][^\s/>]*)/g)].map((m) => m[1].toLowerCase());
  expect([...new Set(tags)].sort()).toEqual(['article', 'p', 'section', 'span']);

  // and the JSON — the source of truth — is unaffected by the highlight
  const words = JSON.parse((await readCurrentProject(page)).saved.json).transcript.words;
  expect(words.some((w) => w.text === 'HIGHLIGHTED')).toBe(true);
});

// #488: opening a project must not lose words. htmlToJSON derives a paragraph's
// end from its last word's END, so a zero-duration final word sits exactly on
// that boundary — the old half-open filter (start >= pStart && start < pEnd)
// excluded it, it never reached the DOM, and the next save wrote the transcript
// without it. Fixture puts a zero-duration word at the end of each paragraph,
// plus a word before the first paragraph starts.
async function buildZeroDurationFixture() {
  const state = {
    generatorVersion: 'e2e',
    created: '2026-08-04T09:00:00Z',
    modified: '2026-08-04T09:30:00Z',
    media: {
      kind: 'original', path: 'media/tone.wav', url: null, filename: 'tone.wav',
      mimeType: 'audio/wav', durationSeconds: 2, sizeBytes: 0,
    },
    options: {
      gapRemoval: { enabled: false, thresholdMs: 700, bufferMs: 150 },
      updateCaptionsFromTranscript: false,
      view: { showSpeakers: true, showTimecodes: false },
    },
    texts: { title: 'Zero duration', language: 'it', summary: '', topics: [] },
    provenance: null,
    hasOriginal: false,
    transcript: {
      words: [
        { start: 0.10, end: 0.20, text: 'PRE' },      // before the first paragraph
        { start: 0.32, end: 0.50, text: 'UNO' },
        { start: 0.50, end: 0.70, text: 'ZEROA' },    // ends where it starts…
        { start: 0.70, end: 0.70, text: 'BOUNDARYA' }, // …on paragraph 1's end
        { start: 0.90, end: 1.10, text: 'TRE' },
        { start: 1.10, end: 1.10, text: 'BOUNDARYB' }, // on paragraph 2's end
      ],
      paragraphs: [
        { speaker: 'Maria', start: 0.32, end: 0.70 },
        { speaker: 'Luca', start: 0.90, end: 1.10 },
      ],
    },
  };
  return save.zipProject({
    json: save.serializeProjectJson(save.buildProjectJson(state)),
    html: '<article><section><p><span data-m="320" data-d="180">UNO </span></p></section></article>',
    originalJson: null,
    captionsVtt: null,
    media: { name: 'tone.wav', data: ladderWav(2) },
  }, JSZip, 'nodebuffer');
}

test('opening keeps words sitting exactly on a paragraph boundary (#488)', async ({ page }, testInfo) => {
  const dialogs = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.accept(); });
  const fixturePath = testInfo.outputPath('zero-duration.hyperaudio');
  fs.writeFileSync(fixturePath, await buildZeroDurationFixture());
  await page.setInputFiles('#project-open-input', fixturePath);
  await expect(page.locator('#hypertranscript')).toContainText('UNO');

  const words = await page.evaluate(() =>
    [...document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')]
      .map((s) => s.textContent.trim()));

  // every word survives the JSON -> DOM projection, in order
  expect(words).toEqual(['PRE', 'UNO', 'ZEROA', 'BOUNDARYA', 'TRE', 'BOUNDARYB']);
  // and each lands in exactly one paragraph — no duplication from the new rule
  expect(words.length).toBe(new Set(words).size);
  expect(await page.locator('#hypertranscript p').count()).toBe(2);
  expect(dialogs).toEqual([]);
});

// #489 — transcript.html is a PROJECTION of the JSON, not a second reading of the
// DOM. #486 briefly derived the JSON from the canonical serializer's output, which
// put the source of truth downstream of a presentation transform: two shapes the
// serializer flattened (a wrapper around word spans, spans outside any <p>)
// stopped being cosmetic and deleted words from the container. Reading once and
// projecting means the two entries cannot disagree, and the shapes that used to
// cost words cost nothing.
test('a wrapper around word spans costs no words in the saved project (#489)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);

  // exactly what Cmd+B over a selection produces, and what a paste of markup
  // used to inject (#487): a <b> ENCLOSING timed word spans
  await page.evaluate(() => {
    const ht = document.getElementById('hypertranscript');
    ht.innerHTML = '<article><section><p>'
      + '<span data-m="0" data-d="100">one </span>'
      + '<b><span data-m="100" data-d="100">two </span>'
      + '<span data-m="200" data-d="100">three </span></b>'
      + '<span data-m="300" data-d="100">four </span>'
      + '</p></section>'
      // and a timed span parked outside every <p>
      + '<section><span data-m="400" data-d="100">five </span></section></article>';
    ht.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await page.keyboard.press('Control+s');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  const saved = (await readCurrentProject(page)).saved;
  const words = JSON.parse(saved.json).transcript.words.map((w) => w.text);

  // every word reaches the JSON — the source of truth
  expect(words).toEqual(['one', 'two', 'three', 'four', 'five']);

  // and the HTML copy carries the same set, so the two entries agree (§ 4)
  const htmlWords = [...saved.html.matchAll(/<span[^>]*data-m[^>]*>([^<]*)</g)]
    .map((m) => m[1].trim())
    .filter((t) => t !== '' && !t.startsWith('['));
  expect(htmlWords).toEqual(words);
});

test('the saved HTML and JSON always describe the same words (#489)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);

  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'PROJECTED ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.keyboard.press('Control+s');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  const saved = (await readCurrentProject(page)).saved;
  const jsonWords = JSON.parse(saved.json).transcript.words.map((w) => w.text);
  expect(jsonWords).toContain('PROJECTED');

  // the projection is generated from that JSON, so a re-parse must agree exactly
  const reparsed = [...saved.html.matchAll(/<span[^>]*data-m[^>]*>([^<]*)</g)]
    .map((m) => m[1].trim())
    .filter((t) => t !== '' && !t.startsWith('['));
  expect(reparsed).toEqual(jsonWords);

  // struck words and the speaker label still survive the round trip
  expect(saved.html).toContain('class="speaker"');
  expect(JSON.parse(saved.json).transcript.words.some((w) => w.struck === true)).toBe(true);
});

// #492 — the invariant is "writers emit >= 1 paragraph", but readers stay
// tolerant: files written before the rule, and third-party JSON, legitimately
// carry none. Opening one must still land every word, and the next save brings
// the project back to conformance rather than preserving the gap.
test('a project with no paragraphs opens whole and is written back with one (#492)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs, (project) => {
    project.transcript.paragraphs = [];
  });
  await awaitLibraryEntry(page);

  // every word reached the editor — not just the one openFixture waits on
  const words = await page.locator('#hypertranscript span[data-m]:not(.speaker)').allTextContents();
  expect(words.map((w) => w.trim())).toEqual(['Benvenuti', 'ehm', 'a']);
  expect(dialogs).toEqual([]);

  // an opened project is CLEAN, so ⌘S alone commits nothing — edit first, which
  // is the path a real file predating the rule would take back to conformance
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'Benvenuto ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);
  await page.keyboard.press('Control+s');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  const saved = (await readCurrentProject(page)).saved;
  const transcript = JSON.parse(saved.json).transcript;
  expect(transcript.words.map((w) => w.text)).toEqual(['Benvenuto', 'ehm', 'a']);
  expect(transcript.paragraphs.length).toBeGreaterThanOrEqual(1);
});

// Undo landing exactly on the last committed state clears the dirty dot (the
// VS Code / NSDocument semantics) — compared by state signature, not by step
// count, so a pending edit undo can't reach keeps the dot honest.
test('undo back to the last save clears the dirty dot and retires the draft', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page); // v0 committed: the screen IS the saved state

  // a real keystroke, so the history module owns the edit
  await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    t.focus();
    const span = t.querySelector('span[data-m]:not(.speaker)');
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(span.firstChild, 2);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  });
  await page.keyboard.type('ZZ');
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);

  await page.keyboard.press('Meta+z');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  // the pre-undo draft dies with the cleanliness — reload must not resurrect
  // "unsaved edits" that no longer exist
  await pollPage(page, async () => {
    const id = window.HyperaudioSave.library.currentId();
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
    try { await dir.getFileHandle('draft.json'); return false; } catch (e) { return true; }
  });

  // and redoing away from the save is dirty again
  await page.keyboard.press('Shift+Meta+z');
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);
});

test('undo back to the save clears the dot even after deferred caption regen (#517 perf)', async ({ page }, testInfo) => {
  // The perf rework defers caption regeneration to a ~3s idle queue. Type,
  // pause past that window (captions now reflect the edit), then undo: the
  // transcript matches the save but the TRACK catches up only in the forced
  // post-restore refresh — which runs after the restored signal. The
  // signature comparison must happen after that refresh, or the dot stays.
  const dialogs = [];
  // caption sync ON — the fixture default is curated captions, whose track
  // never changes and cannot exhibit the drift under test
  await openFixture(page, testInfo, dialogs, (project) => {
    project.options.captions.updateFromTranscript = true;
  });
  await awaitLibraryEntry(page);

  await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    t.focus();
    const span = t.querySelector('span[data-m]:not(.speaker)');
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(span.firstChild, 2);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  });
  // A sync-on save stores MACHINE-generated captions (the fixture's stored
  // vtt is hand-written and regeneration can never reproduce it) — save
  // first, as the scenario implies, so the signature baseline is honest.
  await page.keyboard.press('Control+s');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  await page.keyboard.type('ZZ');
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);
  await page.waitForTimeout(3800); // past the idle reconciliation window

  await page.keyboard.press('Meta+z');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/, { timeout: 6000 });
});

test('multi-step undo back to the save clears the dot promptly (sync-on)', async ({ page }, testInfo) => {
  // Two typed runs, each folded by the local pass, then undo both. At the
  // final undo the transcript matches the save but the caption track still
  // holds the INTERMEDIATE vtt (undo #1's post-restore refresh built it;
  // undo #2's regen is deferred). With sync on the vtt is a pure derivative
  // of the transcript, so the signature must not compare it — otherwise the
  // dot lingers ~3.4s until the recheck. Prompt means within 1s, well under
  // that recheck window, so this test has teeth against the race.
  const dialogs = [];
  await openFixture(page, testInfo, dialogs, (project) => {
    project.options.captions.updateFromTranscript = true;
  });
  await awaitLibraryEntry(page);

  await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    t.focus();
    const span = t.querySelector('span[data-m]:not(.speaker)');
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(span.firstChild, 2);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  });
  await page.keyboard.press('Control+s');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  await page.keyboard.type('XX yy');
  await page.waitForTimeout(1700); // run 1 folds into its history entry
  await page.keyboard.type('zz ww');
  await page.waitForTimeout(1700); // run 2 folds

  await page.keyboard.press('Meta+z');
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/); // one run still applied
  await page.waitForTimeout(500);
  await page.keyboard.press('Meta+z');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/, { timeout: 1000 });
});

test('undo does not clear the dot while a non-transcript edit is pending', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);

  // an edit undo cannot reach: the summary
  await page.evaluate(() => {
    const s = document.getElementById('summary');
    s.textContent = 'still pending';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);

  await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    t.focus();
    const span = t.querySelector('span[data-m]:not(.speaker)');
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(span.firstChild, 2);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  });
  await page.keyboard.type('ZZ');
  await page.keyboard.press('Meta+z'); // transcript back to saved; summary is not

  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);
});

// #513 — the caption editor is populated by parsing the saved VTT, and the
// parse dropped the final cue every time (a single-cue VTT produced no rows at
// all). Not cosmetic: generateCaptionsFromCaptionEditor rebuilds the VTT from
// these rows, so editing any caption made the missing one permanent.
test('every cue in the saved VTT reaches the caption editor (#513)', async ({ page }, testInfo) => {
  const dialogs = [];
  const THREE_CUES = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFirst cue\n\n'
    + '00:00:01.000 --> 00:00:02.000\nSecond cue\n\n'
    + '00:00:02.000 --> 00:00:03.000\nThird cue\n';
  await openFixture(page, testInfo, dialogs, null, THREE_CUES);
  await awaitLibraryEntry(page);

  await page.click('#caption-editor-btn');
  await page.waitForFunction(() => document.querySelectorAll('#captions-display .caption').length > 0);

  const lines = await page.locator('#captions-display .caption input.line1').evaluateAll(
    (els) => els.map((e) => e.value.trim()));
  expect(lines).toEqual(['First cue', 'Second cue', 'Third cue']);
});

// #505 — NO caption edit reached the save module. The three structural buttons
// are onclick handlers that rewrite the caption list without firing an input
// event; typing does fire one, but EDIT_SCOPE names '#caption-editor', which is
// a placeholder in a hidden modal — the real rows live in the transcript holder,
// so the selector matched nothing. Captions changed, the project stayed clean,
// and the edit was lost on close.
const CAPTION = '#captions-display .caption';
const enterCaptionMode = async (page) => {
  await page.click('#caption-editor-btn');
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, CAPTION);
  // Opening a project whose captions are curated raises the "Captions have
  // been edited" notice, and it sits OVER the first caption rows, intercepting
  // clicks — dismiss it the way a user must (see #506, which is about that
  // notice's design).
  const divergence = page.locator('#project-dialog.modal-open');
  if (await divergence.isVisible()) await page.click('#project-dialog-confirm');
  await expect(divergence).toBeHidden();
};

for (const action of ['insert', 'merge', 'delete']) {
  test(`caption ${action} marks the project dirty (#505)`, async ({ page }, testInfo) => {
    const dialogs = [];
    await openFixture(page, testInfo, dialogs);
    await awaitLibraryEntry(page);
    await enterCaptionMode(page);
    await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

    // merge needs a second caption below the first to merge INTO
    if (action === 'merge') {
      await page.locator(CAPTION).first()
        .locator('button', { hasText: 'insert' }).click();
      await page.evaluate(() => window.HyperaudioSave.autosaveNow());
      await page.evaluate(() => {
        document.getElementById('project-save-btn').classList.remove('dirty');
      });
    }

    const countBefore = await page.locator(CAPTION).count();
    await page.locator(CAPTION).first()
      .locator('button', { hasText: action }).click();

    // the caption list really changed...
    const countAfter = await page.locator(CAPTION).count();
    expect(countAfter).toBe(action === 'insert' ? countBefore + 1 : countBefore - 1);
    // ...and the save module heard about it
    await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);
  });
}

test('typing in a caption marks the project dirty (#505)', async ({ page }, testInfo) => {
  // EDIT_SCOPE lists '#caption-editor', but the caption rows are not in it —
  // that id belongs to a hidden modal placeholder — so typing never reached
  // the save module either. The choke-point announcement covers it.
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  await enterCaptionMode(page);
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  await page.locator(CAPTION).first().locator('input.line1').click();
  await page.keyboard.type('EDITED');
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);
});

test('a caption deletion survives the save that follows it (#505)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  await enterCaptionMode(page);

  const firstLine = await page.locator(CAPTION).first()
    .locator('input.line1').inputValue();
  expect(firstLine.trim()).not.toBe('');

  await page.locator(CAPTION).first()
    .locator('button', { hasText: 'delete' }).click();
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);

  await page.keyboard.press('Control+s');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  // the saved VTT no longer carries the deleted cue's text
  const saved = (await readCurrentProject(page)).saved;
  expect(saved.captionsVtt).not.toContain(firstLine.trim());
});


// #502 — building a container reads the media out of OPFS, may download it,
// and packs the whole thing into a blob: seconds to minutes on real media,
// during which the app showed nothing at all. The only prior signal was a
// confirm dialog above 500MB, so an ordinary 100MB interview got none.
// openFixture resolves as soon as the transcript paints, but the open keeps
// running (draft flush, OPFS seeding). Waiting for the progress pill to clear
// is the precise signal that openFromFile's finally has run — without it a
// following open is legitimately refused by the #504 guard.
const awaitOpenIdle = (page) => pollPage(page, async () =>
  document.getElementById('project-progress') === null
  && window.HyperaudioSave.library.currentId() !== null);

const watchProgress = async (page) => {
  const seen = [];
  await page.exposeFunction('__recordProgress', (t) => { seen.push(t); });
  await page.evaluate(() => {
    new MutationObserver(() => {
      const el = document.getElementById('project-progress');
      if (el) window.__recordProgress(el.textContent);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  return seen;
};

test('exporting reports progress, and clears it when the download arrives (#502)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  const seen = await watchProgress(page);

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => document.getElementById('project-export-hyperaudio').click());
  await downloadPromise;

  expect(seen.some((t) => /Preparing/.test(t))).toBe(true);   // click acknowledged
  expect(seen.some((t) => /Packaging.*\d+%/.test(t))).toBe(true); // real percentage
  await expect(page.locator('#project-progress')).toHaveCount(0); // gone when done
  expect(dialogs).toEqual([]);
});

test('a second export while one is running says so rather than nothing (#502)', async ({ page }, testInfo) => {
  const dialogs = [];
  // 10 minutes of audio: packing has to still be running when the hold is
  // checked, which is the whole condition the hold exists for
  await openFixture(page, testInfo, dialogs, null, null, 600);

  const result = await page.evaluate(async () => {
    const first = window.HyperaudioSave.exportProject();   // deliberately not awaited
    const secondPromise = window.HyperaudioSave.exportProject();
    // Read the pill SYNCHRONOUSLY: the refusal path has no await before it
    // shows its message, so the text is correct right now — awaiting first
    // would let the running export overwrite it with its own next stage.
    const el = document.getElementById('project-progress');
    const text = el ? el.textContent : null;
    // the pill is guaranteed on screen at this instant — pin its placement
    const bar = document.getElementById('playbar').getBoundingClientRect();
    const r = el ? el.getBoundingClientRect() : null;
    const box = r ? {
      onScreen: r.top >= 0 && r.left >= 0
        && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      clearsPlaybar: r.bottom <= bar.top,
      visible: getComputedStyle(el).display !== 'none' && r.width > 0,
    } : null;
    const second = await secondPromise;
    await new Promise((r) => setTimeout(r, 400)); // packing is streaming updates
    const stillEl = document.getElementById('project-progress');
    const textAfterDelay = stillEl ? stillEl.textContent : null;
    await first;
    return { second, text, box, textAfterDelay };
  });

  expect(result.second).toBe(false);                 // still one build at a time
  expect(result.text).toMatch(/Still building/);     // but it explains itself
  // and it STAYS readable: packing fires progress updates every few ms, which
  // used to overwrite this before anyone could read it
  expect(result.textAfterDelay).toMatch(/Still building/);
  // and it is actually visible, fully on screen, clear of the play bar
  expect(result.box).toEqual({ onScreen: true, clearsPlaybar: true, visible: true });
});


// #504 — the open path had no in-flight guard, where export has refused
// concurrent runs since #448. Note what this does NOT claim: two concurrent
// opens were measured (including with slow, large media) and produced no
// duplicate library entries and no inconsistent session state — the harm the
// issue predicted did not reproduce. The guard earns its place by bounding the
// concurrency explicitly rather than leaving it to be reasoned about, and by
// telling the user why their second attempt did nothing.
test('the in-flight open explains itself rather than doing nothing (#504)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);

  // Two opens started back to back. The first must GENUINELY still be in
  // flight when the second arrives — an instantly-failing dummy could finish
  // first under CPU contention and the refusal never fire (it did, in full-
  // suite runs on a loaded machine). A real container with long media keeps
  // the first open busy well past the second call.
  const bigPath = testInfo.outputPath('big.hyperaudio');
  fs.writeFileSync(bigPath, await buildFixture(null, null, 600));
  await page.setInputFiles('#project-open-input', bigPath); // lands a File we can reuse
  await awaitOpenIdle(page);
  const text = await page.evaluate(async () => {
    const file = document.getElementById('project-open-input').files[0];
    const first = window.HyperaudioSave.openFromFile(file);
    const second = window.HyperaudioSave.openFromFile(file);
    const el = document.getElementById('project-progress');
    const t = el ? el.textContent : null;
    await Promise.allSettled([first, second]);
    return t;
  });

  expect(text).toMatch(/one at a time/);
});

// #503 — the mirror of #502 on the way in. Opening a real project unzips the
// media into memory, wraps it in a File (a second full copy) and seeds OPFS
// with it, all before the first visible change: seconds of nothing.
test('opening a project reports progress and clears it (#503)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);      // one open to get a File in the input
  await awaitOpenIdle(page);

  // Sample the pill from inside the page while the open runs: the record-to-node
  // bridge is asynchronous and was losing entries against a fast open.
  const result = await page.evaluate(async () => {
    const seen = [];
    const sample = () => {
      const el = document.getElementById('project-progress');
      if (el && seen[seen.length - 1] !== el.textContent) seen.push(el.textContent);
    };
    const timer = setInterval(sample, 5);
    const file = document.getElementById('project-open-input').files[0];
    const p = window.HyperaudioSave.openFromFile(file);
    sample();
    await p;
    clearInterval(timer);
    return { seen, pillLeft: !!document.getElementById('project-progress') };
  });

  expect(result.seen.some((t) => /Opening the project file/.test(t))).toBe(true);
  expect(result.seen.some((t) => /Loading the project/.test(t))).toBe(true);
  expect(result.pillLeft).toBe(false);   // cleared when the work is done
  expect(dialogs).toEqual([]);
});

test('reading a large media reports a percentage while opening (#503)', async ({ page }, testInfo) => {
  const dialogs = [];
  // big enough that JSZip streams the extraction rather than finishing in one tick
  await openFixture(page, testInfo, dialogs, null, null, 600);
  await awaitOpenIdle(page);
  const seen = await watchProgress(page);

  await page.evaluate(async () => {
    const file = document.getElementById('project-open-input').files[0];
    await window.HyperaudioSave.openFromFile(file);
  });
  await page.waitForTimeout(300);

  expect(seen.some((t) => /Reading the media… \d+%/.test(t))).toBe(true);
});

// #519 — the autosave debounce is 1.5s and nothing flushed it at teardown:
// closing the tab dropped the newest keystrokes. The pending draft now lands
// when the page hides (tab/app switch) and on pagehide (iOS close path).
test('hiding the page flushes the pending draft immediately (#519)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);

  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'FLUSHED-ON-HIDE ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // hide the page well inside the 1.5s debounce window
  const t0 = Date.now();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // the draft must land long before the debounce alone could have fired
  await pollPage(page, async () => {
    try {
      const id = window.HyperaudioSave.library.currentId();
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
      const text = await (await (await dir.getFileHandle('draft.json')).getFile()).text();
      return text.indexOf('FLUSHED-ON-HIDE') !== -1;
    } catch (e) { return false; }
  });
  expect(Date.now() - t0).toBeLessThan(1300); // debounce alone fires at 1500ms+

  // a second teardown event must not double-write or throw (pagehide follows
  // visibilitychange in a real close)
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(dialogs).toEqual([]);
});

// #525 — a transcription in flight owns the screen with loader markup and
// aria-busy, and three things went wrong around it: switching "back" to the
// project the session still points at was a silent no-op (the user stared at
// the loader with no way out), switching to another project carried the busy
// state with it, and re-picking the same media file fired no change event so
// a retry after interruption did nothing.
const startFakeTranscription = (page) => page.evaluate(() => {
  document.querySelector('#hypertranscript').innerHTML =
    '<div class="vertically-centre"><center>Transcribing…</center></div>';
  setTranscriptBusy(true);
});

test('switching back to your project mid-transcription rescues it from the loader (#525)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  const homeId = await page.evaluate(() => window.HyperaudioSave.library.currentId());

  await startFakeTranscription(page);
  await expect(page.locator('#hypertranscript')).toContainText('Transcribing…');

  // click your own project's row: previously a silent no-op, now an
  // immediate switch — no consent dialog (#525: the in-progress row is the
  // way back, so leaving needs no ceremony)
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), homeId);

  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti'); // the project is back
  expect(await page.evaluate(() =>
    document.querySelector('#hypertranscript').getAttribute('aria-busy'))).toBeNull(); // busy cleared
  // ...and EDITABLE: busy(true) turned contenteditable off, and until that
  // was undone here every transcript opened mid-transcription had no caret
  await expect(page.locator('#hypertranscript')).toHaveAttribute('contenteditable', 'true');
});


test('the engine file inputs clear on click so the same file can be re-picked (#525)', async ({ page }, testInfo) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const wavPath = testInfo.outputPath('tone.wav');
  const fsm = await import('node:fs');
  fsm.writeFileSync(wavPath, ladderWav(1));
  await page.setInputFiles('#file-input', wavPath);
  expect(await page.evaluate(() => document.querySelector('#file-input').files.length)).toBe(1);

  // the user clicks the input again to re-pick the SAME file: the value must
  // clear so the browser fires change for the identical selection
  await page.evaluate(() => document.querySelector('#file-input')
    .dispatchEvent(new MouseEvent('click')));
  expect(await page.evaluate(() => document.querySelector('#file-input').value)).toBe('');
});

// #525 follow-up — the transcription is a first-class Recents citizen from the
// moment it starts: an in-progress row appears (virtual, in-memory — a reload
// kills the engine, so nothing persists to get stuck), clicking it hands the
// screen back to the live loader, completion replaces it with the real project
// entry, and an engine error takes the row away with it.
test('a transcription appears in Recents while it runs, and resolves on completion (#525)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  const homeId = await page.evaluate(() => window.HyperaudioSave.library.currentId());

  // the user picks a NEW file to transcribe (the capture listener records it)
  const newWav = testInfo.outputPath('brand-new-recording.wav');
  (await import('node:fs')).writeFileSync(newWav, ladderWav(1));
  await page.setInputFiles('#file-input', newWav);

  // an engine starts, exactly as they all do: its own media on the player,
  // loader markup, then busy(true)
  await page.evaluate(() => {
    const player = document.getElementById('hyperplayer');
    player.src = URL.createObjectURL(new Blob([new Uint8Array(4)], { type: 'audio/wav' }));
    document.querySelector('#hypertranscript').innerHTML =
      '<div class="vertically-centre"><center><span class="transcribing-msg">Preparing model…</span></center></div>';
    setTranscriptBusy(true);
  });
  const engineSrc = await page.evaluate(() => document.getElementById('hyperplayer').src);
  const row = page.locator('.recents-row-transcribing');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('brand-new-recording.wav'); // named after ITS file
  await expect(row.locator('.recents-transcribing-spinner')).toBeVisible(); // wordless in-progress signal
  // same footprint as a real row
  const widths = await page.evaluate(() => ({
    pending: document.querySelector('.recents-row-transcribing').getBoundingClientRect().width,
    real: document.querySelector('.recents-row:not(.recents-row-transcribing)').getBoundingClientRect().width,
  }));
  expect(Math.abs(widths.pending - widths.real)).toBeLessThanOrEqual(2);
  // the transcribing row IS the selection while the loader owns the screen —
  // and the previous project's row stands down
  await expect(row.locator('.recents-transcribing-item')).toHaveClass(/active/);
  await expect(page.locator('#file-picker .file-item[data-id].active')).toHaveCount(0);

  // the engine progresses past the initial message, as its interval does
  await page.evaluate(() => {
    document.querySelector('#hypertranscript .transcribing-msg').textContent = 'Transcribing… (0m 42s)';
  });

  // switch away to the existing project — immediate, the row stays but the
  // selection moves to the project actually on screen
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), homeId);
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.recents-transcribing-item')).not.toHaveClass(/active/);
  await expect(page.locator('#file-picker .file-item[data-id].active')).toHaveCount(1);

  // click the row: back to the live loader AT THE DEPARTURE-TIME message —
  // not the stale 'Preparing model' captured when the engine started
  await row.locator('.recents-transcribing-item').click();
  await expect(page.locator('#hypertranscript')).toContainText('Transcribing… (0m 42s)');
  await expect(row.locator('.recents-transcribing-item')).toHaveClass(/active/); // selected again on return
  // the loader view is not for typing in — the leave path restored
  // contenteditable for the project, the way back must take it away again
  await expect(page.locator('#hypertranscript')).toHaveAttribute('contenteditable', 'false');
  // and the player carries the TRANSCRIPTION's media, not the previous project's
  expect(await page.evaluate(() => document.getElementById('hyperplayer').src)).toBe(engineSrc);
  expect(await page.evaluate(() =>
    document.querySelector('#hypertranscript').textContent.includes('Preparing model'))).toBe(false);

  // SECOND hop: progress advances, leave from the PENDING view this time,
  // return again — the snapshot must track every departure, not just the first
  await page.evaluate(() => {
    document.querySelector('#hypertranscript .transcribing-msg').textContent = 'Transcribing… (1m 30s)';
  });
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), homeId);
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  await row.locator('.recents-transcribing-item').click();
  await expect(page.locator('#hypertranscript')).toContainText('Transcribing… (1m 30s)');
  expect(await page.evaluate(() =>
    document.querySelector('#hypertranscript').textContent.includes('0m 42s'))).toBe(false);
  expect(await page.evaluate(() =>
    document.querySelector('#hypertranscript .transcribing-msg') !== null)).toBe(true);

  // completion: transcript lands, busy false, init births — the virtual row
  // resolves into the real project entry
  await page.evaluate(() => {
    document.querySelector('#hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">DONE </span></p></section></article>';
    setTranscriptBusy(false);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  });
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(0);
  await pollPage(page, async () =>
    (await window.HyperaudioSave.library.list()).length === 2); // fixture + birth

  // The birth carries the TRANSCRIPTION's identity, not the project the user
  // happened to be viewing: its name and media are the new recording's, and
  // the player is back on the transcription's own source.
  const born = await page.evaluate(async () => {
    const list = await window.HyperaudioSave.library.list();
    const entry = list.find((e) => e.name !== 'E2E Project');
    return { name: entry.name, mediaFile: entry.media && entry.media.filename,
      playerSrc: document.getElementById('hyperplayer').src };
  });
  expect(born.name).toBe('brand-new-recording.wav');
  expect(born.mediaFile).toBe('brand-new-recording.wav');
  expect(born.playerSrc).toBe(engineSrc);
});

test('a transcription in flight does not play the previous project\'s captions (#525)', async ({ page }, testInfo) => {
  // The player gets the transcription's media at engine start, but the
  // caption <track> kept the previous project's vtt — playing the
  // transcribing video showed the old captions. Both doors into the pending
  // view must clear the track; the birth's own caption pass restores it.
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  const homeId = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  // WebKit's automatic track selection may flip a fresh subtitles track back
  // to 'showing' from inside the browser (no JS setter involved), so mode is
  // not assertable — what matters is that the track holds NO cue data.
  const trackHasVtt = () => page.evaluate(() => {
    const track = document.getElementById('hyperplayer-vtt');
    return track !== null && track.src.startsWith('data:');
  });
  expect(await trackHasVtt()).toBe(true); // the fixture's captions are on

  // engine start: its own media on the player, loader, busy(true)
  const newWav = testInfo.outputPath('captionless-recording.wav');
  (await import('node:fs')).writeFileSync(newWav, ladderWav(1));
  await page.setInputFiles('#file-input', newWav);
  await page.evaluate(() => {
    const player = document.getElementById('hyperplayer');
    player.src = URL.createObjectURL(new Blob([new Uint8Array(4)], { type: 'audio/wav' }));
    document.querySelector('#hypertranscript').innerHTML =
      '<div class="vertically-centre"><center><span class="transcribing-msg">Transcribing…</span></center></div>';
    setTranscriptBusy(true);
  });
  expect(await trackHasVtt()).toBe(false); // door 1: engine start clears the track

  // away to the project (its captions return), then back to the pending view
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), homeId);
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  expect(await trackHasVtt()).toBe(true);
  await page.locator('.recents-transcribing-item').click();
  await expect(page.locator('#hypertranscript')).toContainText('Transcribing…');
  expect(await trackHasVtt()).toBe(false); // door 2: the way back clears it too

  // completion: the birth generates the NEW transcript's captions, exactly
  // as the engines do (init, then the generate dispatch)
  await page.evaluate(() => {
    document.querySelector('#hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">DONE </span></p></section></article>';
    setTranscriptBusy(false);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  });
  await pollPage(page, async () => {
    const track = document.getElementById('hyperplayer-vtt');
    return track !== null && track.src.startsWith('data:');
  });
});

test('a phantom engine error does not let the birth steal another project\'s identity (#529 × #525)', async ({ page }, testInfo) => {
  // The measured Parakeet failure mode: handleError fires (error markup +
  // busy(false)) — then the worker recovers and completes anyway. The row
  // dies with the error signal, correctly; the transcription's identity must
  // not, or the recovered birth is named after and paired with whatever
  // project the user was viewing.
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  const homeId = await page.evaluate(() => window.HyperaudioSave.library.currentId());

  const newWav = testInfo.outputPath('phantom-recording.wav');
  (await import('node:fs')).writeFileSync(newWav, ladderWav(1));
  await page.setInputFiles('#file-input', newWav);
  await page.evaluate(() => {
    const player = document.getElementById('hyperplayer');
    player.src = URL.createObjectURL(new Blob([new Uint8Array(4)], { type: 'audio/wav' }));
    document.querySelector('#hypertranscript').innerHTML =
      '<div class="vertically-centre"><center><span class="transcribing-msg">Preparing model…</span></center></div>';
    setTranscriptBusy(true);
  });
  const engineSrc = await page.evaluate(() => document.getElementById('hyperplayer').src);

  // the user is viewing another project when the phantom error hits
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), homeId);
  await page.evaluate(() => {
    document.querySelector('#hypertranscript').innerHTML =
      '<div class="vertically-centre"><center>Sorry. Transcription failed.</center></div>';
    setTranscriptBusy(false); // handleError's signal — the row goes
  });
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(0);

  // ...and then the worker recovers and completes
  await page.evaluate(() => {
    document.querySelector('#hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">RECOVERED </span></p></section></article>';
    setTranscriptBusy(false);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  });
  await pollPage(page, async () => (await window.HyperaudioSave.library.list()).length === 2);

  const born = await page.evaluate(async () => {
    const list = await window.HyperaudioSave.library.list();
    const entry = list.find((e) => e.name !== 'E2E Project');
    return { name: entry.name, mediaFile: entry.media && entry.media.filename,
      playerSrc: document.getElementById('hyperplayer').src };
  });
  expect(born.name).toBe('phantom-recording.wav');      // not the fixture's name
  expect(born.mediaFile).toBe('phantom-recording.wav'); // not the fixture's media
  expect(born.playerSrc).toBe(engineSrc);               // not the fixture's video
});

test('the in-progress row sits atop Recents, below the Starred group (#554)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  await page.evaluate(async () => {
    const lib = window.HyperaudioSave.library;
    const original = lib.currentId();
    await lib.duplicate(original);   // an unstarred neighbour for the Recents group
    await lib.setStarred(original, true);
  });
  await expect(page.locator('#file-picker .recents-group-heading h2').first()).toHaveText('Starred');

  await startFakeTranscription(page);
  // the row arrives with the panel re-render — await it before reading shape
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(1);
  const shape = () => page.evaluate(() =>
    [...document.querySelectorAll('#file-picker > li')].map((li) =>
      li.classList.contains('recents-group-heading') ? 'H:' + li.textContent.trim()
        : li.classList.contains('recents-row-transcribing') ? 'pending'
          : li.classList.contains('recents-row') ? 'row' : 'other:' + li.textContent.trim().slice(0, 20)));
  // births are unstarred: the pending row belongs at the TOP OF RECENTS —
  // below the whole Starred group, above the unstarred rows
  expect(await shape()).toEqual(['H:Starred', 'row', 'H:Recents', 'pending', 'row']);
});

test('an engine error takes the in-progress row with it (#525)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(() => {
    document.querySelector('#hypertranscript').innerHTML =
      '<div class="vertically-centre"><center><span class="transcribing-msg">Transcribing…</span></center></div>';
    setTranscriptBusy(true);
  });
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(1);

  // the engines' error path: error markup, busy(false), no init ever
  await page.evaluate(() => {
    document.querySelector('#hypertranscript').innerHTML =
      '<div class="vertically-centre"><center>Sorry. An unexpected error has occurred.</center></div>';
    setTranscriptBusy(false);
  });
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(0);
});

// #525 — one transcription at a time: the engines share one transcript
// element and one busy flag, so a second start mid-run interleaved into
// errors. The entry points grey out while busy.
test('the NEW button is inert while a transcription runs — even from another project (#525)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  const homeId = await page.evaluate(() => window.HyperaudioSave.library.currentId());

  await page.evaluate(() => {
    document.querySelector('#hypertranscript').innerHTML =
      '<div class="vertically-centre"><center><span class="transcribing-msg">Transcribing…</span></center></div>';
    setTranscriptBusy(true);
  });
  const newBtn = page.locator('#new-transcription-btn');
  await expect(newBtn).toHaveCSS('pointer-events', 'none');
  // and the modal genuinely cannot be opened through it
  await newBtn.click({ force: true }).catch(() => {});
  expect(await page.evaluate(() => document.getElementById('transcribe-modal').checked)).toBe(false);

  // the hole this test exists for: switch AWAY (which clears the view's busy
  // attribute) — the engine still runs, so the gate must hold
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), homeId);
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  expect(await page.evaluate(() =>
    document.querySelector('#hypertranscript').getAttribute('aria-busy'))).toBeNull();
  await expect(newBtn).toHaveCSS('pointer-events', 'none'); // STILL gated

  // engine ends: the door reopens
  await page.evaluate(() => {
    document.querySelector('#hypertranscript').innerHTML = '<p>err</p>';
    setTranscriptBusy(false);
  });
  await expect(newBtn).not.toHaveCSS('pointer-events', 'none');
  await newBtn.click();
  expect(await page.evaluate(() => document.getElementById('transcribe-modal').checked)).toBe(true);
});

// Swapping the player's src (every project switch) stops playback without a
// pause event; the playbar synced only on play/pause/ended, so switching away
// from a playing video showed the pause button over a video that wasn't
// playing. 'emptied' is the event the load algorithm actually fires.
test('the play button state survives a project switch away from a playing video', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);
  const firstId = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  const p2 = testInfo.outputPath('second.hyperaudio');
  (await import('node:fs')).writeFileSync(p2, await buildFixture());
  await page.setInputFiles('#project-open-input', p2);
  await pollPage(page, async (prev) => window.HyperaudioSave.library.currentId() !== prev
    && document.getElementById('project-progress') === null, firstId);

  // play the second project's media (muted, so headless allows it)
  await page.evaluate(async () => {
    const v = document.getElementById('hyperplayer');
    v.muted = true;
    await v.play();
  });
  await expect(page.locator('#playbar-play-icon')).toBeHidden(); // pause icon showing

  // switch to the first project: not playing there — the button must say so
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), firstId);
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  expect(await page.evaluate(() => document.getElementById('hyperplayer').paused)).toBe(true);
  await expect(page.locator('#playbar-play-icon')).toBeVisible(); // play icon back
});

// Switching projects while the transcript is focused left the HOST focused
// across the content swap, with the selection collapsed to host offset 0 —
// a stray caret rendered on a phantom line above the first paragraph.
// Opening a project is not an edit: apply() drops focus.
test('a project switch does not leave a stray caret above the transcript', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await awaitLibraryEntry(page);

  const result = await page.evaluate(async () => {
    const HS = window.HyperaudioSave;
    const a = HS.library.currentId();
    await HS.library.duplicate(a);
    const b = (await HS.library.list()).find((e) => e.id !== a).id;

    // the user is editing project A: caret inside the first word
    const t = document.getElementById('hypertranscript');
    t.focus();
    const span = t.querySelector('span[data-m]:not(.speaker)');
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(span.firstChild, 2);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);

    await HS.library.open(b);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      hostStillFocused: document.activeElement === t,
      selectionOnHost: window.getSelection().anchorNode === t,
    };
  });
  expect(result.hostStillFocused).toBe(false);
  expect(result.selectionOnHost).toBe(false);
});

// #587 — switching back to a project restores your place: scroll (anchored to
// the first visible word, not pixels) and the paused playhead. An UNKNOWN
// project opens at its top — previously replaceChildren kept the scroll
// container's offset, so the incoming project inherited the outgoing one's
// scroll position. Session-only: nothing persists.
test('a project switch restores scroll and playhead; unknown projects start at the top (#587)', async ({ page }, testInfo) => {
  const dialogs = [];
  // a long transcript, so there is somewhere to scroll to
  await openFixture(page, testInfo, dialogs, (project) => {
    // word0 keeps the fixture's expected first word: openFixture asserts it
    const words = [{ text: 'Benvenuti ', start: 0, end: 0.4 }];
    for (let i = 1; i < 600; i += 1) {
      words.push({ text: 'word' + i + ' ', start: i * 0.5, end: i * 0.5 + 0.4 });
    }
    project.transcript.words = words;
    project.transcript.paragraphs = [{ speaker: '', start: 0, end: 300 }];
  });
  await awaitLibraryEntry(page);
  const longId = await page.evaluate(() => window.HyperaudioSave.library.currentId());

  // a second, short project to switch to
  await page.evaluate(async (id) => { await window.HyperaudioSave.library.duplicate(id); }, longId);
  const shortId = await page.evaluate(async (a) => {
    const list = await window.HyperaudioSave.library.list();
    return list.find((e) => e.id !== a).id;
  }, longId);

  // scroll deep into the long project and note the first visible word
  const anchorM = await page.evaluate(() => {
    const holder = document.querySelector('.transcript-holder');
    holder.scrollTop = holder.scrollHeight / 2;
    const top = holder.getBoundingClientRect().top;
    const words = document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)');
    for (const s of words) {
      if (s.getBoundingClientRect().bottom >= top) return s.getAttribute('data-m');
    }
    return null;
  });
  expect(anchorM).not.toBeNull();

  // park the playhead mid-media before leaving
  await page.evaluate(() => {
    const player = document.getElementById('hyperplayer');
    if (player.readyState >= 1) player.currentTime = 3;
  });

  // switching to the OTHER copy must open at ITS top, not inherit the offset
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), shortId);
  await page.waitForFunction((id) => window.HyperaudioSave.library.currentId() === id, shortId);
  expect(await page.evaluate(() => document.querySelector('.transcript-holder').scrollTop)).toBe(0);

  // ...and switching BACK restores the anchored word to the visible top
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), longId);
  await page.waitForFunction((id) => window.HyperaudioSave.library.currentId() === id, longId);
  const restored = await page.evaluate(() => {
    const holder = document.querySelector('.transcript-holder');
    const top = holder.getBoundingClientRect().top;
    const words = document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)');
    for (const s of words) {
      if (s.getBoundingClientRect().bottom >= top) {
        return { m: s.getAttribute('data-m'), scrollTop: holder.scrollTop };
      }
    }
    return null;
  });
  expect(restored.scrollTop).toBeGreaterThan(0);
  expect(Math.abs(Number(restored.m) - Number(anchorM))).toBeLessThanOrEqual(1000); // within ~2 words
});

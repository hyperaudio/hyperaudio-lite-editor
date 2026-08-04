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

async function buildFixture() {
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
  return save.zipProject({
    json: save.serializeProjectJson(save.buildProjectJson(state)),
    html: '<article><section><p><span data-m="320" data-d="520">Benvenuti </span></p></section></article>',
    originalJson: JSON.stringify({ words: [{ start: 0.32, end: 0.84, text: 'benvenuti' }], paragraphs: [] }),
    captionsVtt: FIXTURE_VTT,
    media: { name: 'tone.wav', data: ladderWav(2) },
  }, JSZip, 'nodebuffer');
}

// Open the fixture in the live page via the module's hidden input; collect any
// native dialogs (a conformant open must produce none).
async function openFixture(page, testInfo, dialogs) {
  const fixturePath = testInfo.outputPath('fixture.hyperaudio');
  fs.writeFileSync(fixturePath, await buildFixture());
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

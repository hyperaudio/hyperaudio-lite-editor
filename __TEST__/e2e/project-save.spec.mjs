// .hyperaudio project save/open (js/hyperaudio-save.js; spec: docs/format/).
// Drives the shipped editor end to end: opens a conformant container built
// with the module's own pure layers, checks that transcript (redactions
// included), captions, options and texts land in the editor; downloads a save
// and verifies the container; reloads and checks the OPFS working-copy restore.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { ladderWav } from './helpers.mjs';

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
  await expect(page.locator('#file-exportimport-submenu #project-open-hyperaudio')).toHaveText('Import Project (.hyperaudio)');
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

test('saving downloads a conformant container that round-trips', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => document.getElementById('project-save-btn').click());
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
  // the origin travelled along, untouched and struck-free
  expect(JSON.parse(loaded.originalText).words[0].text).toBe('benvenuti');
  expect(loaded.captionsVtt).toContain('Benvenuti a Hyperaudio');
  expect(loaded.project.provenance.originalTranscript).toBe('transcript.original.json');
});

test('the working copy survives a reload (OPFS restore)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);

  // the open seeds OPFS and sets the synchronous boot hint
  await page.waitForFunction(() => localStorage.getItem('hyperaudioWorkPresent') === '1');

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');

  // the restored project replaces the static demo transcript
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');
  await expect(page.locator('#hypertranscript span[data-m="840"]')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(page.locator('#remove-gaps-threshold')).toHaveValue('700');
  const src = await page.evaluate(() => document.querySelector('#hyperplayer').src);
  expect(src).toMatch(/^blob:/);

  // the project title survived the restore in the session (no UI field until
  // #449): a save after reload still suggests the title-derived filename
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => document.getElementById('project-save-btn').click());
  expect((await downloadPromise).suggestedFilename()).toBe('E2E Project.hyperaudio');
});

test('dirty open: danger triad styling, and "Save and open" saves then opens (#449)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]');
    span.textContent = 'DIRTY ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // open the fixture again over the dirty project
  await page.evaluate(() => { document.getElementById('project-open-input').value = ''; });
  const fixturePath = testInfo.outputPath('fixture.hyperaudio');
  await page.setInputFiles('#project-open-input', fixturePath);
  await awaitModal(page);
  expect(await projectModal(page)).toContain('DISCARD');
  expect(await page.evaluate(() => ({
    danger: document.getElementById('project-dialog-confirm').classList.contains('btn-error'),
    saveLabel: document.getElementById('project-dialog-extra').textContent,
    focused: document.activeElement && document.activeElement.id,
    cancelHidden: document.getElementById('project-dialog-cancel').style.display === 'none',
  }))).toEqual({ danger: true, saveLabel: 'Save and open', focused: 'project-dialog-extra', cancelHidden: true });

  const downloadPromise = page.waitForEvent('download');
  await page.click('#project-dialog-extra');
  expect((await downloadPromise).suggestedFilename()).toBe('E2E Project.hyperaudio'); // saved…
  await expect(page.locator('#hypertranscript')).toContainText('Benvenuti');          // …then opened
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);
});

test('an unopenable file is refused BEFORE the replace-confirmation, project untouched', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  // dirty the project so the replace-warning WOULD apply to a valid open
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]');
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
  await page.waitForFunction(() => localStorage.getItem('hyperaudioWorkPresent') === '1');

  // the round trip that REPLACES #hypertranscript — direct listeners died here
  await page.click('#caption-editor-btn');
  await page.waitForTimeout(400);
  await page.click('#transcript-editor-btn');
  await page.waitForTimeout(400);

  const before = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const f = await (await root.getFileHandle('app-state.json')).getFile();
    return JSON.parse(await f.text()).lastWorkWriteAt || 0;
  });

  // an edit on the REPLACED transcript element must still reach the autosave
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]');
    span.textContent = 'POST-ROUNDTRIP ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(2500);

  const after = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('work');
    const state = JSON.parse(await (await (await root.getFileHandle('app-state.json')).getFile()).text());
    const snapshot = JSON.parse(await (await (await dir.getFileHandle('snapshot.json')).getFile()).text());
    return { at: state.lastWorkWriteAt || 0, html: snapshot.html };
  });
  expect(after.at).toBeGreaterThan(before);
  expect(after.html).toContain('POST-ROUNDTRIP');
});

test('Save button: dirty dot appears on edit, click saves and clears it (#449)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await expect(page.locator('#project-save-btn')).toHaveCount(1);
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);

  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]');
    span.textContent = 'DIRTY ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);

  const downloadPromise = page.waitForEvent('download');
  await page.click('#project-save-btn');
  expect((await downloadPromise).suggestedFilename()).toBe('E2E Project.hyperaudio');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);
});

test('Ctrl/⌘-S saves with the project title (#449)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  const downloadPromise = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  expect((await downloadPromise).suggestedFilename()).toBe('E2E Project.hyperaudio');
});

test('the native bridge intercepts the save instead of a download (#449)', async ({ page }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  await page.evaluate(() => {
    window.__bridgeSaved = null;
    window.hyperaudioProjectBridge = {
      save(blob, name) { window.__bridgeSaved = { size: blob.size, name }; return true; },
    };
    const span = document.querySelector('#hypertranscript span[data-m]');
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

test('the quit guard arms on unsaved changes and disarms after a save (#449)', async ({ page }, testInfo) => {
  // Tests the guard's arming logic via a cancelable synthetic event —
  // defaultPrevented is precisely what the browser reads to decide whether
  // to prompt. The prompt itself is platform chrome (and headless Chromium's
  // dialog plumbing for real closes is unreliable); manual testing covers it.
  const dialogs = [];
  await openFixture(page, testInfo, dialogs);
  const armed = () => page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });

  expect(await armed()).toBe(false); // freshly opened: clean

  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]');
    span.textContent = 'UNSAVED ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(await armed()).toBe(true);  // dirty: leaving would prompt

  const downloadPromise = page.waitForEvent('download');
  await page.click('#project-save-btn');
  await downloadPromise;
  expect(await armed()).toBe(false); // saved: leaving is silent again
});

test('a second tab is guarded: banner, no slot writes, promotion on owner close (#450)', async ({ page, context }, testInfo) => {
  const dialogs = [];
  await openFixture(page, testInfo, dialogs); // tab 1 owns the slot
  await page.waitForFunction(() => localStorage.getItem('hyperaudioWorkPresent') === '1');
  const ownerSnapshot = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('work');
    return (await (await dir.getFileHandle('snapshot.json')).getFile()).text();
  });

  // tab 2: banner shown, and its transcription must NOT touch the owner's slot
  const page2 = await context.newPage();
  await page2.goto('/index.html');
  await page2.waitForSelector('#hypertranscript [data-m]');
  await expect(page2.locator('#tab-guard-banner')).toBeVisible();
  // tab 2 did not boot-restore the owner's project — it shows the demo
  await expect(page2.locator('#hypertranscript')).not.toContainText('Benvenuti');

  await page2.evaluate(() => {
    document.querySelector('#hyperplayer').src = 'https://example.com/media/tab2.mp4';
    document.querySelector('#hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">TAB-TWO </span></p></section></article>';
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    const span = document.querySelector('#hypertranscript span[data-m]');
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page2.waitForTimeout(2200); // outlive the autosave debounce
  const afterSnapshot = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('work');
    return (await (await dir.getFileHandle('snapshot.json')).getFile()).text();
  });
  expect(afterSnapshot).toBe(ownerSnapshot); // untouched by tab 2

  // owner closes → tab 2 is promoted: banner drops
  await page.close();
  await expect(page2.locator('#tab-guard-banner')).toHaveCount(0);
  await page2.close();
});

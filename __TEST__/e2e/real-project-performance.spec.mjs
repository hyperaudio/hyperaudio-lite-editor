// Optional performance/regression probe driven by a real .hyperaudio project.
// Usage:
//   HLE_REAL_PROJECT='/path/to/project.hyperaudio' \
//     npx playwright test __TEST__/e2e/real-project-performance.spec.mjs
//
// By default the test rebuilds a transcript-only container from the real
// project, avoiding a large media copy while preserving every real word,
// paragraph, timing, style and option. Set HLE_REAL_PROJECT_FULL=1 to make the
// browser open the original archive including its media.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const save = require('../../js/hyperaudio-save.js');
const projectPath = process.env.HLE_REAL_PROJECT || '';

async function browserFixture(testInfo) {
  if (process.env.HLE_REAL_PROJECT_FULL === '1') return projectPath;
  const source = await JSZip.loadAsync(fs.readFileSync(projectPath));
  const project = JSON.parse(await source.file('hyperaudio.json').async('string'));
  project.media = {
    kind: 'none', path: null, url: null, filename: '', mimeType: '',
    durationSeconds: 0, sizeBytes: 0,
  };
  const fixture = await save.zipProject({
    json: save.serializeProjectJson(project),
    html: await source.file('transcript.html').async('string'),
    originalJson: source.file('transcript.original.json')
      ? await source.file('transcript.original.json').async('string') : null,
    captionsVtt: source.file('captions.vtt')
      ? await source.file('captions.vtt').async('string') : '',
  }, JSZip, 'nodebuffer');
  const fixturePath = testInfo.outputPath('real-transcript.hyperaudio');
  fs.writeFileSync(fixturePath, fixture);
  return fixturePath;
}

test('real project preserves editing, local maintenance, undo and redo', async ({ page }, testInfo) => {
  test.skip(!projectPath || !fs.existsSync(projectPath),
    'Set HLE_REAL_PROJECT to a readable .hyperaudio file');
  test.setTimeout(240000);

  const source = await JSZip.loadAsync(fs.readFileSync(projectPath));
  const project = JSON.parse(await source.file('hyperaudio.json').async('string'));
  const expectedWords = project.transcript.words.length;
  const expectedParagraphs = project.transcript.paragraphs.length;

  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript span[data-m]');
  await page.setInputFiles('#project-open-input', await browserFixture(testInfo));
  await expect.poll(() => page.locator('#hypertranscript span[data-m]:not(.speaker)').count(), {
    timeout: 60000,
  }).toBe(expectedWords);

  await page.evaluate(({ expectedWords, expectedParagraphs }) => {
    window.hyperaudioFlushTranscriptMaintenance('real-project-ready', {
      force: true,
      global: true,
    });
    const transcript = document.getElementById('hypertranscript');
    const paragraphs = transcript.querySelectorAll('p');
    const paragraph = paragraphs[Math.floor(paragraphs.length / 2)];
    const word = paragraph.querySelector('span[data-m]:not(.speaker)');
    const wordStart = word.getAttribute('data-m');
    const original = word.textContent;
    transcript.focus();
    const range = document.createRange();
    range.setStart(word.firstChild, Math.min(1, word.firstChild.length));
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const historyBefore = window.transcriptHistory.inspect();
    let resolveInput;
    const inputDone = new Promise((resolve) => { resolveInput = resolve; });
    // Register after the application listeners and on their same bubbling
    // target, so the timestamp includes history's post-edit snapshot.
    document.addEventListener('input', () => resolveInput(performance.now()), { once: true });
    window.__realProjectProbe = {
      expectedWords,
      expectedParagraphs,
      wordStart,
      original,
      historyBefore,
      maintenanceBefore: window.hyperaudioInspectTranscriptMaintenance(),
      inputDone,
      keyStarted: performance.now(),
    };
  }, { expectedWords, expectedParagraphs });

  // Use the browser input pipeline, not execCommand: the optimization under
  // test starts at beforeinput, exactly as it does for a real user key.
  await page.keyboard.insertText('x');

  const report = await page.evaluate(async () => {
    const probe = window.__realProjectProbe;
    const inputAt = await probe.inputDone;
    const transcript = document.getElementById('hypertranscript');
    const keyMs = inputAt - probe.keyStarted;
    const maintenanceAfterKey = window.hyperaudioInspectTranscriptMaintenance();

    const maintenanceStarted = performance.now();
    window.hyperaudioFlushTranscriptMaintenance('real-project-maintenance');
    const maintenanceMs = performance.now() - maintenanceStarted;
    const maintenance = window.hyperaudioInspectTranscriptMaintenance();

    const undoStarted = performance.now();
    const undone = window.transcriptHistory.undo();
    const undoMs = performance.now() - undoStarted;
    const liveWord = () => transcript.querySelector(
      `span[data-m="${CSS.escape(probe.wordStart)}"]:not(.speaker)`);
    const afterUndo = liveWord().textContent;
    const redone = window.transcriptHistory.redo();
    const afterRedo = liveWord().textContent;
    const history = window.transcriptHistory.inspect();

    return {
      expectedWords: probe.expectedWords,
      actualWords: transcript.querySelectorAll('span[data-m]:not(.speaker)').length,
      expectedParagraphs: probe.expectedParagraphs,
      actualParagraphs: transcript.querySelectorAll('p').length,
      original: probe.original,
      afterUndo,
      afterRedo,
      keyMs: +keyMs.toFixed(1),
      maintenanceMs: +maintenanceMs.toFixed(1),
      undoMs: +undoMs.toFixed(1),
      maintenanceMode: maintenance.lastMode,
      maintenanceScopes: maintenance.lastScopeCount,
      maintenanceBefore: probe.maintenanceBefore,
      maintenanceAfterKey,
      history,
      fullSnapshots: history.fullSnapshotCount - probe.historyBefore.fullSnapshotCount,
      paragraphSnapshots: (history.paragraphSnapshotCount ?? history.reusedSnapshotCount)
        - (probe.historyBefore.paragraphSnapshotCount ?? probe.historyBefore.reusedSnapshotCount),
      undone,
      redone,
    };
  });

  console.log('REAL_PROJECT_PERFORMANCE ' + JSON.stringify(report));
  await testInfo.attach('real-project-performance.json', {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: 'application/json',
  });

  expect(report.actualWords).toBe(report.expectedWords);
  expect(report.actualParagraphs).toBe(report.expectedParagraphs);
  expect(report.maintenanceMode).toBe('local');
  expect(report.maintenanceScopes).toBe(1);
  expect(report.undone).toBe(true);
  expect(report.redone).toBe(true);
  expect(report.afterUndo).toBe(report.original);
  expect(report.afterRedo).not.toBe(report.original);
  if ('paragraphSnapshotCount' in report.history || 'reusedSnapshotCount' in report.history) {
    expect(report.paragraphSnapshots).toBeGreaterThan(0);
  }
  if ('localEntries' in report.history) {
    expect(report.fullSnapshots).toBe(0);
    expect(report.history.localEntries).toBeGreaterThan(0);
  }
});

// INDEPENDENT undo/redo tests (#400) — a second witness to transcript-history.
//
// Provenance is what makes this file worth keeping alongside
// transcript-history.spec.mjs: it was written blind, against the engine
// probes posted to #400 (what native undo measurably does after each
// programmatic mutation — entries killed by the normalize passes, ⌘Z acting
// at a distance), before this implementation was known to this session. It
// asserts observable behaviour only — real keystrokes in, DOM and timings
// out; the sole implementation reference is one canRedo() probe.
//
// Caveat: because it was written against a different implementation of the
// same contract, overlap with transcript-history.spec.mjs is deliberate and
// is the point — two suites from independent derivations agreeing is the
// same defence the format doc's anti-divergence rule gives the container.
// If a behaviour change breaks one suite but not the other, treat that as
// signal, not noise.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

const words = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#hypertranscript span[data-m]')]
    .filter((s) => !s.classList.contains('speaker'))
    .map((s) => ({ t: s.textContent, m: +s.getAttribute('data-m'), d: +s.getAttribute('data-d') })));

const wordAt = async (page, text) => (await words(page)).find((w) => w.t.trim() === text);

const caretIn = (page, word, offset) => page.evaluate(({ word, offset }) => {
  const t = document.querySelector('#hypertranscript');
  t.focus();
  const span = [...t.querySelectorAll('span[data-m]')]
    .find((s) => s.textContent.trim() === word);
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStart(span.firstChild, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}, { word, offset });

// the app's own mid-typing normalize trigger: synthetic blur, focus retained
const normalize = (page) => page.evaluate(() =>
  document.querySelector('#hypertranscript').dispatchEvent(new Event('blur')));

test('typing is undoable and redoable, timings intact', async ({ page }) => {
  const before = await wordAt(page, 'makes');
  await caretIn(page, 'makes', 2);
  await page.keyboard.type('XX');
  expect(await wordAt(page, 'maXXkes')).toBeTruthy();

  await page.keyboard.press('Meta+z');
  expect(await wordAt(page, 'makes')).toEqual(before);

  await page.keyboard.press('Shift+Meta+z');
  const redone = await wordAt(page, 'maXXkes');
  expect(redone).toBeTruthy();
  expect(redone.m).toBe(before.m);
});

test('ONE ⌘Z steps over a merge normalize, back to before the keystroke', async ({ page }) => {
  // The scenario native undo fails: Backspace joins two words, the normalize
  // pass merges their spans (a node removal), and native ⌘Z then does nothing
  // in Chromium / reverts an unrelated older edit in WebKit. The module must
  // restore both words with their ORIGINAL timings in a single press.
  const lite = await wordAt(page, 'Lite');
  const editor = await wordAt(page, 'Editor');
  const countBefore = (await words(page)).length;

  await caretIn(page, 'Editor', 0);
  await page.keyboard.press('Backspace');
  await normalize(page);
  expect(await wordAt(page, 'LiteEditor')).toBeTruthy(); // merge really fired
  expect((await words(page)).length).toBe(countBefore - 1);

  await page.keyboard.press('Meta+z');
  expect(await wordAt(page, 'Lite')).toEqual(lite);
  expect(await wordAt(page, 'Editor')).toEqual(editor);
  expect((await words(page)).length).toBe(countBefore);

  // the restored state is canonical — the next normalize pass must not undo the undo
  await normalize(page);
  expect(await wordAt(page, 'Lite')).toEqual(lite);
});

test('ONE ⌘Z steps over a split normalize; the invented timings go with it', async ({ page }) => {
  const before = await wordAt(page, 'makes');
  await caretIn(page, 'makes', 2);
  await page.keyboard.type(' ');
  await normalize(page);
  const half = await wordAt(page, 'kes'); // split fired, pro-rata timing invented
  expect(half).toBeTruthy();
  expect(half.m).toBeGreaterThan(before.m);

  await page.keyboard.press('Meta+z');
  expect(await wordAt(page, 'makes')).toEqual(before);
  expect(await wordAt(page, 'kes')).toBeUndefined();
});

test('no action at a distance: ⌘Z reverts the LATEST edit, older edits stand', async ({ page }) => {
  // Native's measured failure inverted: an old edit (XX in "makes"), then a
  // join elsewhere. The first ⌘Z must revert the JOIN and leave XX alone; the
  // second reverts XX. (Native: first press dead or reverts XX immediately.)
  await caretIn(page, 'makes', 2);
  await page.keyboard.type('XX');
  await caretIn(page, 'Editor', 0);
  await page.keyboard.press('Backspace');
  await normalize(page);
  expect(await wordAt(page, 'LiteEditor')).toBeTruthy();

  await page.keyboard.press('Meta+z');
  expect(await wordAt(page, 'Lite')).toBeTruthy();      // join reverted
  expect(await wordAt(page, 'maXXkes')).toBeTruthy();   // older edit untouched

  await page.keyboard.press('Meta+z');
  expect(await wordAt(page, 'makes')).toBeTruthy();     // now the older edit
});

test('Replace All is one undoable entry', async ({ page }) => {
  const before = await wordAt(page, 'makes');
  await page.locator('#search-box').click();
  await page.keyboard.type('makes');
  await page.waitForSelector('#hypertranscript mark');
  await page.locator('#find-replace-toggle').click();
  await page.locator('#replace-box').click();
  await page.keyboard.type('REPLACED');
  await page.locator('#replace-all').click();
  expect(await wordAt(page, 'REPLACED')).toBeTruthy();

  await page.locator('#hypertranscript').click();
  await page.keyboard.press('Meta+z');
  const restored = await wordAt(page, 'makes');
  expect(restored).toBeTruthy();
  expect(restored.m).toBe(before.m);
  expect(await wordAt(page, 'REPLACED')).toBeUndefined();
});

test('a pause splits typing into separately undoable runs', async ({ page }) => {
  await caretIn(page, 'makes', 2);
  await page.keyboard.type('AB');
  await page.waitForTimeout(700); // > the 500ms group delay
  await page.keyboard.type('CD');
  expect(await wordAt(page, 'maABCDkes')).toBeTruthy();

  await page.keyboard.press('Meta+z');
  expect(await wordAt(page, 'maABkes')).toBeTruthy();  // CD alone reverted
  await page.keyboard.press('Meta+z');
  expect(await wordAt(page, 'makes')).toBeTruthy();
});

test('a new edit clears redo', async ({ page }) => {
  await caretIn(page, 'makes', 2);
  await page.keyboard.type('XX');
  await page.keyboard.press('Meta+z');
  expect(await page.evaluate(() => window.transcriptHistory.canRedo())).toBe(true);
  await caretIn(page, 'audio', 2);
  await page.keyboard.type('Y');
  expect(await page.evaluate(() => window.transcriptHistory.canRedo())).toBe(false);
});

test('restore re-indexes the player word list and announces an input', async ({ page }) => {
  await page.evaluate(() => {
    window.__inputs = 0;
    document.addEventListener('input', () => { window.__inputs += 1; }, true);
  });
  await caretIn(page, 'makes', 2);
  await page.keyboard.type(' '); // split: span count will change
  await normalize(page);
  await page.evaluate(() => { window.__inputs = 0; });
  await page.keyboard.press('Meta+z');

  const r = await page.evaluate(() => {
    const domNodes = [...document.querySelectorAll('#hypertranscript span[data-m]')];
    const arrNodes = (window.hyperaudioInstance.wordArr || []).map((w) => w.n);
    return {
      inputs: window.__inputs,
      indexed: arrNodes.length === domNodes.length && domNodes.every((n) => arrNodes.includes(n)),
    };
  });
  expect(r.inputs).toBeGreaterThanOrEqual(1); // the autosave hears the undo
  expect(r.indexed).toBe(true);               // highlighting will still work
});

test('an empty stack consumes ⌘Z without touching the transcript', async ({ page }) => {
  // Letting the chord fall through to the native stack is exactly the
  // action-at-a-distance the module exists to prevent.
  const before = await page.evaluate(() => document.querySelector('#hypertranscript').innerHTML);
  await caretIn(page, 'makes', 2);
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  const after = await page.evaluate(() => document.querySelector('#hypertranscript').innerHTML);
  expect(after).toBe(before);
});

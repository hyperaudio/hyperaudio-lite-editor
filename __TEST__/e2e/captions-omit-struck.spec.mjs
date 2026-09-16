// #633 — a struck word is cut from the media, so it has no business in a cue.
// caption.js reads every [data-m] from the transcript and knows nothing of
// strikes, so generated captions carried words nobody would hear. Generation
// now works from a copy with the struck spans removed; the transcript itself
// keeps them, because a strike is reversible.
import { test, expect } from '@playwright/test';

const WORD = 'Hyperaudio';          // appears more than once in the intro, so count rather than contain
const NEIGHBOUR = 'Editor';         // still spoken, still in the cues

const occurrences = (text, word) => text.split(word).length - 1;

// Strike the Nth occurrence (0-based) of a word in the transcript.
const strikeNth = (page, word, n) => page.evaluate(([word, n]) => {
  const spans = [...document.querySelectorAll('#hypertranscript span[data-m]')]
    .filter((s) => s.textContent.trim() === word);
  if (spans[n] === undefined) return false;
  spans[n].style.textDecoration = 'line-through';
  return true;
}, [word, n]);

const regenerate = (page) => page.evaluate(() => {
  hyperaudioGenerateCaptionsFromTranscript();
  return window.HyperaudioSave.getCaptionsVtt();
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('a struck word leaves the cues, and its neighbours stay (#633)', async ({ page }) => {
  const before = await regenerate(page);
  expect(occurrences(before, WORD)).toBeGreaterThan(0);   // the fixture is only useful if it starts there

  expect(await strikeNth(page, WORD, 0)).toBe(true);
  const after = await regenerate(page);
  expect(occurrences(after, WORD)).toBe(occurrences(before, WORD) - 1);
  expect(after).toContain(NEIGHBOUR);
  expect(after.startsWith('WEBVTT')).toBe(true);
});

test('the transcript keeps the struck word: a strike is reversible (#633)', async ({ page }) => {
  await strikeNth(page, WORD, 0);
  await regenerate(page);
  const state = await page.evaluate((word) => {
    const spans = [...document.querySelectorAll('#hypertranscript span[data-m]')]
      .filter((s) => s.textContent.trim() === word);
    return { count: spans.length, firstStruck: spans[0].style.textDecoration.includes('line-through') };
  }, WORD);
  expect(state.count).toBeGreaterThan(0);
  expect(state.firstStruck).toBe(true);
});

test('unstriking puts the word back in the cues (#633)', async ({ page }) => {
  const before = await regenerate(page);
  await strikeNth(page, WORD, 0);
  const struck = await regenerate(page);
  expect(occurrences(struck, WORD)).toBe(occurrences(before, WORD) - 1);

  await page.evaluate((word) => {
    const span = [...document.querySelectorAll('#hypertranscript span[data-m]')]
      .find((s) => s.textContent.trim() === word);
    span.style.textDecoration = '';
  }, WORD);
  expect(occurrences(await regenerate(page), WORD)).toBe(occurrences(before, WORD));
});

test('the caption view generates without struck words too (#633)', async ({ page }) => {
  const before = await regenerate(page);
  await strikeNth(page, WORD, 0);
  // entering the caption editor regenerates from the cached transcript, which
  // is the other route into caption.js
  await page.click('#caption-editor-btn');
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.getCaptionsVtt()))
    .toContain('WEBVTT');
  const inView = await page.evaluate(() => window.HyperaudioSave.getCaptionsVtt());
  expect(occurrences(inView, WORD)).toBe(occurrences(before, WORD) - 1);
});

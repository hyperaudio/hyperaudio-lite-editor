// Regression guards for the cut model (strikeouts + gap skipping) that drives
// both playback skipping and edited media export. These exercise the SHIPPED
// code via window.getPlayableSections — the exact datasets from #383 and #371.
import { test, expect } from '@playwright/test';
import { sectionsFor, ISSUE_383_WORDS, ISSUE_371_WORDS } from './helpers.mjs';

const kept = (sections) => +sections.reduce((a, s) => a + (s.end - s.start), 0).toFixed(3);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function');
});

test('#383: a struck run is ONE cut — its inter-word silences go too (gaps off)', async ({ page }) => {
  const sections = await sectionsFor(page, ISSUE_383_WORDS, { gapsOn: false, duration: 45 });
  // exactly one cut, spanning first struck word start → last struck word end
  expect(sections).toEqual([
    { start: 0, end: 17.92 },
    { start: 22.08, end: 45 },
  ]);
  expect(+(45 - kept(sections)).toFixed(3)).toBe(4.16); // the reporter's arithmetic
});

test('#383: with gaps on, the edge buffer never keeps struck audio', async ({ page }) => {
  const sections = await sectionsFor(page, ISSUE_383_WORDS, { gapsOn: true, duration: 45 });
  // the struck-run cut must still span exactly 17.92 → 22.08 (kept words touch
  // the run with zero gap, so no buffer applies there)
  const endsAtRun = sections.find((s) => s.end === 17.92);
  const resumesAfterRun = sections.find((s) => s.start === 22.08);
  expect(endsAtRun).toBeTruthy();
  expect(resumesAfterRun).toBeTruthy();
});

test('#371: pauses around struck filler words merge into the cut (gaps on)', async ({ page }) => {
  const sections = await sectionsFor(page, ISSUE_371_WORDS, { gapsOn: true, duration: 58.599 });
  // verified boundaries from the #371 fix: the "and …um… uses" region cuts
  // [13.86 → 17.26] and "Yeah …Uh… you" cuts [28.34 → 29.18]
  expect(sections).toEqual([
    { start: 0, end: 2.42 },
    { start: 3.34, end: 3.62 },
    { start: 5.02, end: 9.3 },
    { start: 9.66, end: 9.94 },
    { start: 11.58, end: 13.14 },
    { start: 13.58, end: 13.86 },
    { start: 17.26, end: 19.46 },
    { start: 19.98, end: 20.26 },
    { start: 20.94, end: 28.34 },
    { start: 29.18, end: 58.599 },
  ]);
});

test('gaps off: a single struck word cuts exactly its own span', async ({ page }) => {
  const sections = await sectionsFor(page, [[1000, 500], [3000, 500, 1], [6000, 500]], { gapsOn: false, duration: 10 });
  expect(sections).toEqual([
    { start: 0, end: 3 },
    { start: 3.5, end: 10 },
  ]);
});

test('overlapping struck word timings are tolerated (run end = max end)', async ({ page }) => {
  // second struck word starts before the first ends, and ends earlier
  const sections = await sectionsFor(page, [[1000, 500], [3000, 1000, 1], [3200, 300, 1], [6000, 500]], { gapsOn: false, duration: 10 });
  expect(sections).toEqual([
    { start: 0, end: 3 },
    { start: 4, end: 10 },
  ]);
});

test('no strikeouts, gaps off: one full section', async ({ page }) => {
  const sections = await sectionsFor(page, [[1000, 500], [2000, 500]], { gapsOn: false, duration: 10 });
  expect(sections).toEqual([{ start: 0, end: 10 }]);
});

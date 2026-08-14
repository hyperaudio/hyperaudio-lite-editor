import { test, expect } from '@playwright/test';
import { ladderWav, transcriptHtml } from './helpers.mjs';

// #577 — gap skipping must consider the two gaps most likely to be long: the
// silence before anyone speaks and the dead air after the last word. Both were
// invisible to it: regions were only built BETWEEN kept words, and the trailing
// region existed only when struck words followed the last one.

const load = async (page, seconds, words) => {
  const wav = ladderWav(seconds);
  await page.route('**/__ladder.wav', (route) => route.fulfill({ body: wav, contentType: 'audio/wav' }));
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function');
  await page.evaluate(async () => {
    const blob = await (await fetch('/__ladder.wav')).blob();
    document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
  });
  await page.waitForFunction((s) => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 1 && p.duration > s - 1;
  }, seconds);
  await page.evaluate((html) => { document.getElementById('hypertranscript').innerHTML = html; }, transcriptHtml(words));
};

const sectionsWithGaps = (page, on) => page.evaluate((enabled) => {
  document.getElementById('remove-gaps-enabled').checked = enabled;
  document.getElementById('remove-gaps-enabled').dispatchEvent(new Event('change', { bubbles: true }));
  return window.getPlayableSections();
}, on);

test('the silence before the first word is skipped (#577)', async ({ page }) => {
  // speech occupies 4s–7s of a 10s file: 4s of lead-in, 3s of tail
  await load(page, 10, [[4000, 1000, 0], [5000, 1000, 0], [6000, 1000, 0]]);

  const off = await sectionsWithGaps(page, false);
  expect(off[0].start).toBe(0); // unchanged when gap skipping is off

  const on = await sectionsWithGaps(page, true);
  // playback now starts at the first word (less the edge buffer), not at 0
  expect(on[0].start).toBeGreaterThan(3.5);
  expect(on[0].start).toBeLessThanOrEqual(4);
});

test('the dead air after the last word is skipped (#577)', async ({ page }) => {
  await load(page, 10, [[4000, 1000, 0], [5000, 1000, 0], [6000, 1000, 0]]);
  const on = await sectionsWithGaps(page, true);
  const last = on[on.length - 1];
  // ...and ends at the last word, not at the media's end
  expect(last.end).toBeLessThan(8);
  expect(last.end).toBeGreaterThanOrEqual(7);
});

test('a short lead-in is left alone, like any sub-threshold gap (#577)', async ({ page }) => {
  // 0.3s before the first word: under the 0.5s default threshold
  await load(page, 6, [[300, 1000, 0], [1300, 1000, 0]]);
  const on = await sectionsWithGaps(page, true);
  expect(on[0].start).toBe(0);
});

test('struck words in the lead-in are not cut twice (#577)', async ({ page }) => {
  // a struck word inside the lead-in region, then speech
  await load(page, 10, [[1000, 500, 1], [4000, 1000, 0], [5000, 1000, 0]]);
  const on = await sectionsWithGaps(page, true);
  // one continuous kept span from the first kept word onward — no slivers of
  // the lead-in surviving between overlapping cuts
  const kept = on.filter((s) => s.end - s.start > 0.01);
  expect(kept.length).toBe(1);
  expect(kept[0].start).toBeGreaterThan(3.5);
});

// PLAYBACK, not just export (#577). The two are separate mechanisms: export
// consumes getPlayableSections, while playback jumps via checkStrikeThrus —
// which only ever examined the bands BETWEEN kept sections, so the lead-in
// played in full even once the sections themselves were right.
const playheadAfter = async (page, at) => page.evaluate(async (t) => {
  const p = document.getElementById('hyperplayer');
  p.currentTime = t;
  p.dispatchEvent(new Event('timeupdate'));
  await new Promise((r) => setTimeout(r, 120));
  return p.currentTime;
}, at);

test('playback skips the lead-in instead of playing it (#577)', async ({ page }) => {
  await load(page, 10, [[4000, 1000, 0], [5000, 1000, 0], [6000, 1000, 0]]);
  await sectionsWithGaps(page, true);

  expect(await playheadAfter(page, 0)).toBeGreaterThan(2);   // jumped forward
  expect(await playheadAfter(page, 0)).toBeLessThan(4.5);    // ...to the speech
});

test('playback lets the media end rather than run out the dead air (#577)', async ({ page }) => {
  await load(page, 10, [[4000, 1000, 0], [5000, 1000, 0], [6000, 1000, 0]]);
  await sectionsWithGaps(page, true);

  const after = await playheadAfter(page, 7.5); // past the last word
  expect(after).toBeGreaterThan(9.5);           // taken to the end
});

test('with gap skipping OFF the playhead is left alone (#577)', async ({ page }) => {
  await load(page, 10, [[4000, 1000, 0], [5000, 1000, 0], [6000, 1000, 0]]);
  await sectionsWithGaps(page, false);
  expect(await playheadAfter(page, 0)).toBeLessThan(0.5);
  expect(await playheadAfter(page, 7.5)).toBeLessThan(8);
});

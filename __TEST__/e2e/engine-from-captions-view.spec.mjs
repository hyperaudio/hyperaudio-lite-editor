// #787 — in the captions view #hypertranscript is off the page, and engines
// paint their loader and their result into it. Every engine clicked back to
// the transcript view first, but nothing required it, and nothing stopped a
// switch to captions mid-run, after which the result had nowhere to land.
// Now the contract's own calls leave the captions view, and the view is
// locked while the transcript is busy.
import { test, expect } from '@playwright/test';
import { ladderWav, transcriptHtml, pollPage } from './helpers.mjs';

const RESULT = transcriptHtml([[0, 400, 0, 'Landed'], [500, 400, 0, 'after'], [1000, 400, 0, 'all']]);
const LOADER = '<div class="vertically-centre"><center class="transcribing-msg">Transcribing…</center></div>';

const captionsPressed = (page) => page.evaluate(() => document.getElementById('caption-editor-btn').getAttribute('aria-pressed') === 'true');
// greyed by the page's own state (a busy transcript on the page), not by an attribute that could go stale
const captionsDisabled = (page) => page.evaluate(() => getComputedStyle(document.getElementById('caption-editor-btn')).cursor === 'default');

// an engine that follows the written contract and nothing more: media on the
// player, the loader through showTranscriptNotice, then busy(true)
const startEngine = (page) => page.evaluate(async (bytes) => {
  const player = document.getElementById('hyperplayer');
  player.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }));
  showTranscriptNotice('<div class="vertically-centre"><center class="transcribing-msg">Transcribing…</center></div>');
  setTranscriptBusy(true);
}, [...ladderWav(1)]);

const finishEngine = (page) => page.evaluate((html) => {
  if (window.hyperaudioKeepTranscription({ html, summary: '', topics: [], info: null })) return 'kept';
  document.querySelector('#hypertranscript').innerHTML = html;
  setTranscriptBusy(false);
  document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  return 'landed';
}, RESULT);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await pollPage(page, async () => (await window.HyperaudioSave.library.list()).length === 1);
});

test('an engine started from the captions view gets its loader and lands its result (#787)', async ({ page }) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
  expect(await captionsPressed(page)).toBe(true);

  await startEngine(page);
  // the contract's calls left the captions view: the loader is on the page,
  // the transcript is busy, and the library saw the start (its in-progress row)
  expect(await captionsPressed(page)).toBe(false);
  await expect(page.locator('#hypertranscript .transcribing-msg')).toBeVisible();
  expect(await page.evaluate(() => document.getElementById('hypertranscript').getAttribute('aria-busy'))).toBe('true');
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(1);

  expect(await finishEngine(page)).toBe('landed');
  await expect(page.locator('#hypertranscript [data-m]').first()).toContainText('Landed');
  await expect(page.locator('.recents-row-transcribing')).toHaveCount(0);
});

test('the captions view is locked while the transcript is busy, and free again after (#787)', async ({ page }) => {
  await startEngine(page);
  expect(await captionsDisabled(page)).toBe(true);
  await page.click('#caption-editor-btn');
  await page.waitForTimeout(200);
  // declined: the loader stays, the transcript view stays
  expect(await captionsPressed(page)).toBe(false);
  await expect(page.locator('#hypertranscript .transcribing-msg')).toBeVisible();

  expect(await finishEngine(page)).toBe('landed');
  await expect(page.locator('#hypertranscript [data-m]').first()).toContainText('Landed');
  expect(await captionsDisabled(page)).toBe(false);
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
  expect(await captionsPressed(page)).toBe(true);
  await expect(page.locator('#captions-display .caption textarea.lines').first()).toHaveValue(/Landed/);
});

test('the lock lifts when the user switches away, and the result then goes to Recents (#787)', async ({ page }) => {
  const homeId = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await startEngine(page);
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), homeId);
  await page.waitForSelector('#hypertranscript [data-m]');
  // the project's transcript is not busy: captions are the user's to open
  expect(await captionsDisabled(page)).toBe(false);
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');

  // the engine finishes while the user is in that project's captions: kept
  // in the background, nothing written on screen, the captions view stays
  expect(await finishEngine(page)).toBe('kept');
  expect(await captionsPressed(page)).toBe(true);
  await expect.poll(() => page.evaluate(async () => (await window.HyperaudioSave.library.list()).length)).toBe(2);
});

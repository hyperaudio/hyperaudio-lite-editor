// #737 — times past an hour. The paragraph timecodes and Recents switched to
// h:mm:ss at an hour, while the play bar read 75:20 / 92:05 beside a margin
// saying 1:15:20, and Export media's lengths and the clip's file name ran
// their minutes past 59 too. One rule now: m:ss under an hour, h:mm:ss from
// an hour on. The player's clock is stood in for, since no fixture runs an
// hour.
import { test, expect } from '@playwright/test';
import { ladderWav } from './helpers.mjs';

// the player reports the times we say, whatever it holds
const pretend = (page, currentTime, duration) => page.evaluate(([t, d]) => {
  const v = document.getElementById('hyperplayer');
  Object.defineProperty(v, 'duration', { configurable: true, get: () => d });
  Object.defineProperty(v, 'currentTime', { configurable: true, get: () => t, set: () => {} });
  v.dispatchEvent(new Event('durationchange'));
  v.dispatchEvent(new Event('timeupdate'));
}, [currentTime, duration]);

test('the play bar shows hours from an hour on, and minutes before', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await pretend(page, 125, 3599);
  await expect(page.locator('#playbar-time')).toHaveText('2:05 / 59:59');
  await pretend(page, 4520, 5525);
  await expect(page.locator('#playbar-time')).toHaveText('1:15:20 / 1:32:05');
  await pretend(page, 0, 3600);
  await expect(page.locator('#playbar-time')).toHaveText('0:00 / 1:00:00');
});

test('Export media shows the clip and the length in hours, and names the clip with them', async ({ page }) => {
  const wav = ladderWav(2, 8000);
  await page.route('**/__long.wav', (route) => route.fulfill({ body: wav, contentType: 'audio/wav' }));
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function');
  await page.evaluate(async () => {
    const blob = await (await fetch('/__long.wav')).blob();
    document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
  });
  await page.waitForFunction(() => document.getElementById('hyperplayer').readyState >= 1);
  // a two-hour recording, by its own account, with words past the hour
  await pretend(page, 0, 7200);
  await page.evaluate(() => {
    const words = Array.from({ length: 10 }, (_, i) => `<span data-m="${(4520 + i) * 1000}" data-d="1000">w${i} </span>`).join('');
    document.getElementById('hypertranscript').innerHTML = `<article><section><p>${words}</p></section></article>`;
  });
  await page.evaluate(() => {
    const spans = document.querySelectorAll('#hypertranscript [data-m]');
    const range = document.createRange();
    range.setStart(spans[0].firstChild, 0);
    range.setEnd(spans[9].firstChild, spans[9].textContent.trimEnd().length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  await page.evaluate(() => {
    document.activeElement && document.activeElement.blur();
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
  // w0 starts at 1:15:20, w9 ends at 1:15:30: padded a tenth each way
  await expect(page.locator('#export-clip-summary')).toHaveText('(1:15:20–1:15:30, 0:10)');
  expect(await page.inputValue('#export-name')).toMatch(/-1h15m20s$/);
  // the whole recording's length, in the speed panel's "was" readout
  await page.check('#export-source-entire');
  await expect(page.locator('#export-length-orig')).toContainText('2:00:00');
});

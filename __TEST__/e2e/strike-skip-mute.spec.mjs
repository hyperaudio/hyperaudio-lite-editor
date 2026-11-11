// #795 — a struck word's first syllable was heard while the skip's seek was
// in flight. Setting currentTime starts an asynchronous seek and the element
// keeps playing the old position until it lands: ~18 ms from a local server,
// 96–196 ms from a custom URL scheme in a WKWebView, and speech starts about
// 50 ms into a struck word's span. The skip now mutes the player for the
// seek and gives the user's own mute state back on seeked, without the
// playbar's mute icon flashing on every skip.
import { test, expect } from '@playwright/test';
import { ladderWav, transcriptHtml } from './helpers.mjs';

// words at 1 s intervals from 2 s; the test strikes the third (4–5 s)
const WORDS = [[2000, 1000, 0], [3000, 1000, 0], [4000, 1000, 0], [5000, 1000, 0], [6000, 1000, 0]];

const load = async (page) => {
  const wav = ladderWav(10);
  await page.route('**/__ladder.wav', (route) => route.fulfill({ body: wav, contentType: 'audio/wav' }));
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function');
  await page.evaluate(async () => {
    const blob = await (await fetch('/__ladder.wav')).blob();
    document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 1 && p.duration > 9;
  });
  await page.evaluate((html) => { document.getElementById('hypertranscript').innerHTML = html; }, transcriptHtml(WORDS));
  // strike the third word through the button, whose path rebuilds the kept
  // sections and attaches the skip listeners
  await page.evaluate(() => {
    const spans = document.querySelectorAll('#hypertranscript [data-m]');
    const r = document.createRange();
    r.selectNodeContents(spans[2]);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.getElementById('hypertranscript').focus();
  });
  await page.click('#strikethrough');
  const sections = await page.evaluate(() => window.getPlayableSections());
  expect(sections.length).toBe(2);
  expect(sections[0].end).toBeCloseTo(4, 1);
  expect(sections[1].start).toBeCloseTo(5, 1);
};

// Seek into the struck word and let the skip fire, recording the player's
// mute state at every seeking, and the icon at every volumechange.
const skipFrom = (page, at) => page.evaluate(async (t) => {
  const p = document.getElementById('hyperplayer');
  const muteIcon = document.getElementById('playbar-mute-icon');
  const log = { seeking: [], icons: [] };
  p.addEventListener('seeking', () => log.seeking.push({ t: Math.round(p.currentTime * 100) / 100, muted: p.muted }));
  p.addEventListener('volumechange', () => log.icons.push(muteIcon.style.display));
  p.currentTime = t;
  p.dispatchEvent(new Event('timeupdate'));
  await new Promise((r) => setTimeout(r, 400));
  log.after = { t: p.currentTime, muted: p.muted, flag: p.dataset.skipMute || null, icon: muteIcon.style.display };
  return log;
}, at);

test('the skip mutes the player for its seek and unmutes it after (#795)', async ({ page }) => {
  await load(page);
  const log = await skipFrom(page, 4.2);

  // the skip's own seek ran muted, and landed past the struck word
  const skip = log.seeking.find((s) => s.t >= 4.9);
  expect(skip).toBeTruthy();
  expect(skip.muted).toBe(true);
  expect(log.after.t).toBeGreaterThan(4.9);
  // the user's unmuted state is back, and the flag is gone
  expect(log.after.muted).toBe(false);
  expect(log.after.flag).toBeNull();
  // the playbar's mute icon never showed
  expect(log.icons.every((d) => d === 'none')).toBe(true);
  expect(log.after.icon).toBe('none');
});

test('a user who was muted stays muted through a skip (#795)', async ({ page }) => {
  await load(page);
  await page.evaluate(() => { document.getElementById('hyperplayer').muted = true; });
  const log = await skipFrom(page, 4.2);
  expect(log.after.t).toBeGreaterThan(4.9);
  expect(log.after.muted).toBe(true);
  expect(log.after.flag).toBeNull();
});

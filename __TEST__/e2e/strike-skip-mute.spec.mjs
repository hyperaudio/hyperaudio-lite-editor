// #795/#800 — a struck word's first syllable was heard while the skip's seek
// was in flight: setting currentTime starts an asynchronous seek and the
// element keeps playing the old position until it lands (~18 ms from a local
// server, 80–200 ms from a custom URL scheme in a WKWebView), and WebKit's
// media element reports currentTime behind the sound it produces. Two
// measures, by where the playhead is when the skip fires. Inside a cut (a
// seek into it) the skip mutes the player for its seek and gives the user's
// own mute state back on seeked, without the playbar's icon flashing.
// Approaching a cut while playing, in WebKit or for a host that set a lead,
// the skip seeks early and unmuted, so the sound jumps at the cut itself. A
// skip lands 30 ms before the next kept word, never inside it.
import { test, expect, webkit, chromium } from '@playwright/test';
import { ladderWav, transcriptHtml } from './helpers.mjs';

// words at 1 s intervals from 2 s; the default strike is the third (4–5 s).
// With gap removal off the first kept section runs from 0, so the kept
// sections are [0, 4) and [5, 10].
const WORDS = [[2000, 1000, 0], [3000, 1000, 0], [4000, 1000, 0], [5000, 1000, 0], [6000, 1000, 0]];

const strikeWord = async (page, index) => {
  await page.evaluate((i) => {
    const spans = document.querySelectorAll('#hypertranscript [data-m]');
    const r = document.createRange();
    r.selectNodeContents(spans[i]);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.getElementById('hypertranscript').focus();
  }, index);
  await page.click('#strikethrough');
};

const load = async (page, words = WORDS, strike = [2]) => {
  const wav = ladderWav(10);
  await page.route('**/__ladder.wav', (route) => route.fulfill({ body: wav, contentType: 'audio/wav' }));
  await page.goto('http://localhost:4173/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function');
  await page.evaluate(async () => {
    const blob = await (await fetch('/__ladder.wav')).blob();
    document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 1 && p.duration > 9;
  });
  await page.evaluate((html) => { document.getElementById('hypertranscript').innerHTML = html; }, transcriptHtml(words));
  // strike through the button, whose path rebuilds the kept sections and
  // attaches the skip listeners
  for (const i of strike) await strikeWord(page, i);
  return page.evaluate(() => window.getPlayableSections());
};

const round = (x) => Math.round(x * 100) / 100;

// Record every seek the SKIP issues, as it is issued: wrapping the element's
// currentTime setter sees the skip's own sets, where the seeking event fires
// later and can belong to an earlier seek. `from` is the time the player was
// at when the set came (sampled every 5 ms while playing).
const armSeekLog = (page) => page.evaluate(() => {
  const p = document.getElementById('hyperplayer');
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  const log = { sets: [], icons: [], last: desc.get.call(p) };
  window.__seekLog = log;
  log.sampler = setInterval(() => { log.last = desc.get.call(p); }, 5);
  Object.defineProperty(p, 'currentTime', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) {
      log.sets.push({ from: Math.round(log.last * 100) / 100, to: Math.round(v * 100) / 100, muted: p.muted, flag: p.dataset.skipMute || null });
      desc.set.call(this, v);
      log.last = v;
    },
  });
  p.addEventListener('volumechange', () => log.icons.push(document.getElementById('playbar-mute-icon').style.display));
});

const readSeekLog = (page) => page.evaluate(() => {
  const p = document.getElementById('hyperplayer');
  const log = window.__seekLog;
  clearInterval(log.sampler);
  return {
    // the first set is the test's own seek; the rest are the skip's
    skips: log.sets.slice(1),
    icons: log.icons,
    after: { t: p.currentTime, muted: p.muted, flag: p.dataset.skipMute || null, icon: document.getElementById('playbar-mute-icon').style.display },
  };
});

// Seek to `at` (paused) and let the skip fire.
const skipFrom = async (page, at) => {
  await armSeekLog(page);
  await page.evaluate(async (t) => {
    const p = document.getElementById('hyperplayer');
    p.currentTime = t;
    p.dispatchEvent(new Event('timeupdate'));
    await new Promise((r) => setTimeout(r, 400));
  }, at);
  return readSeekLog(page);
};

// Park at `at`, then PLAY (muted, so autoplay rules allow it) for `ms`.
const playFrom = async (page, at, ms = 700) => {
  await armSeekLog(page);
  await page.evaluate(async ({ at, ms }) => {
    const p = document.getElementById('hyperplayer');
    p.muted = true;
    p.currentTime = at;
    await new Promise((r) => p.addEventListener('seeked', r, { once: true }));
    await p.play();
    await new Promise((r) => setTimeout(r, ms));
    p.pause();
  }, { at, ms });
  return readSeekLog(page);
};

test('a seek into the cut skips muted, lands 30 ms before the next word and unmutes after (#795, #800)', async ({ page }) => {
  const sections = await load(page);
  expect(sections.length).toBe(2);
  expect(sections[0].end).toBeCloseTo(4, 1);
  expect(sections[1].start).toBeCloseTo(5, 1);
  const log = await skipFrom(page, 4.2);

  // one skip only, muted and flagged, landing just before 5 s: the landing
  // is outside the band it covers, so it never skips again
  expect(log.skips).toEqual([{ from: 4.2, to: 4.97, muted: true, flag: '1' }]);
  expect(round(log.after.t)).toBe(4.97);
  // the user's unmuted state is back, and the flag is gone
  expect(log.after.muted).toBe(false);
  expect(log.after.flag).toBeNull();
  // the playbar's mute icon never showed
  expect(log.icons.every((d) => d === 'none')).toBe(true);
  expect(log.after.icon).toBe('none');
});

test('with gaps skipped, the leading gap lands 30 ms before the first kept sound, once (#577, #800)', async ({ page }) => {
  await load(page);
  // gap removal on: the silence before 2 s is cut, less the 100 ms buffer
  await page.evaluate(() => {
    const el = document.getElementById('remove-gaps-enabled'); // inside its closed dialog
    el.checked = true;
    el.dispatchEvent(new Event('change'));
  });
  const sections = await page.evaluate(() => window.getPlayableSections());
  expect(round(sections[0].start)).toBe(1.9);
  const log = await skipFrom(page, 0.5);
  expect(log.skips).toEqual([{ from: 0.5, to: 1.87, muted: true, flag: '1' }]);
  expect(round(log.after.t)).toBe(1.87);
});

// WebKit's media element reports currentTime behind the sound it produces,
// so there the skip seeks 0.27 s ahead of the cut, unmuted, and the sound
// jumps at the cut. Chromium reports true time, gets no lead, and skips
// muted when currentTime reaches the cut.
for (const [name, engine, leads] of [['WebKit', webkit, true], ['Chromium', chromium, false]]) {
  test(`${name}: ${leads ? 'seeks 0.27 s before the cut, unmuted' : 'no lead, seeks muted at the cut'} (#800)`, async () => {
    const browser = await engine.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await load(page);
      const log = await playFrom(page, 3.6);
      expect(log.skips.length, JSON.stringify(log.skips)).toBe(1);
      const skip = log.skips[0];
      expect(skip.to).toBe(4.97);
      if (leads) {
        expect(skip.from).toBeGreaterThanOrEqual(3.72);
        expect(skip.from).toBeLessThan(3.8);
        expect(skip.flag).toBeNull();
      } else {
        expect(skip.from).toBeGreaterThanOrEqual(3.99);
        expect(skip.from).toBeLessThan(4.1);
        expect(skip.flag).toBe('1');
      }
    } finally {
      await browser.close();
    }
  });
}

test('a host sets its own lead on window.hyperaudioSkipLead (#800)', async ({ page }) => {
  await load(page);
  await page.evaluate(() => { window.hyperaudioSkipLead = 0.5; });
  const log = await playFrom(page, 3.3);
  expect(log.skips.length, JSON.stringify(log.skips)).toBe(1);
  expect(log.skips[0].from).toBeGreaterThanOrEqual(3.49);
  expect(log.skips[0].from).toBeLessThan(3.6);
  expect(log.skips[0].flag).toBeNull();
  // out of range or not a number: the default again
  await page.evaluate(() => { window.hyperaudioSkipLead = 'soon'; });
  const again = await playFrom(page, 3.6);
  expect(again.skips.length, JSON.stringify(again.skips)).toBe(1);
  expect(again.skips[0].from).toBeGreaterThanOrEqual(3.99);
});

test('the lead never jumps a word while paused (#800)', async ({ page }) => {
  await load(page);
  await page.evaluate(() => { window.hyperaudioSkipLead = 0.5; });
  // a click on the last word before the cut, paused: the playhead stays
  const log = await skipFrom(page, 3.7);
  expect(log.skips).toEqual([]);
  expect(round(log.after.t)).toBe(3.7);
});

test('a kept word shorter than two leads is not skipped by the early seek (#800)', async ({ page }) => {
  // the third word is 100 ms long and kept, between two struck words
  const words = [[2000, 1000, 0], [3000, 1000, 0], [4000, 100, 0], [4100, 1000, 0], [5100, 1000, 0]];
  const sections = await load(page, words, [1, 3]);
  expect(sections.map((s) => [round(s.start), round(s.end)])).toEqual([[0, 3], [4, 4.1], [5.1, 10]]);
  await page.evaluate(() => { window.hyperaudioSkipLead = 0.5; });
  const log = await playFrom(page, 3.97);
  const skip = log.skips.find((s) => s.to > 5);
  expect(skip, JSON.stringify(log.skips)).toBeTruthy();
  // the skip waited for the cut at 4.1 and ran muted, so the short word played
  expect(skip.from).toBeGreaterThanOrEqual(4.09);
  expect(skip.flag).toBe('1');
  expect(skip.to).toBe(5.07);
});

test('a user who was muted stays muted through a skip (#795)', async ({ page }) => {
  await load(page);
  await page.evaluate(() => { document.getElementById('hyperplayer').muted = true; });
  const log = await skipFrom(page, 4.2);
  expect(round(log.after.t)).toBe(4.97);
  expect(log.after.muted).toBe(true);
  expect(log.after.flag).toBeNull();
});

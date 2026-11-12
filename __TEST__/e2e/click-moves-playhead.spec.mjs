// #797 — a click on a word moves the playhead there while the media is
// paused. On by default, as people expect from other transcript editors, and
// a Playback setting because of the pause-and-fix habit: pause, click a word
// a few seconds back, fix it, play, which then resumes from the fixed word.
// Never starts playback, and while the media plays a click only places the
// caret, so editing behind the playhead is untouched.
import { test, expect } from '@playwright/test';
import { ladderWav, transcriptHtml } from './helpers.mjs';

const WORDS = [[2000, 1000, 0, 'two'], [3000, 1000, 0, 'three'], [4000, 1000, 0, 'four'], [5000, 1000, 0, 'five'], [6000, 1000, 0, 'six']];

const load = async (page) => {
  const wav = ladderWav(10);
  await page.route('**/__ladder.wav', (route) => route.fulfill({ body: wav, contentType: 'audio/wav' }));
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(async (html) => {
    const blob = await (await fetch('/__ladder.wav')).blob();
    document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
    document.getElementById('hypertranscript').innerHTML = html;
  }, transcriptHtml(WORDS));
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 1 && p.duration > 9;
  });
};

const word = (page, i) => page.locator('#hypertranscript span[data-m]').nth(i);
const player = (page) => page.evaluate(() => {
  const p = document.getElementById('hyperplayer');
  return { t: Math.round(p.currentTime * 100) / 100, paused: p.paused };
});

test('paused, a click on a word moves the playhead there and does not play (#797)', async ({ page }) => {
  await load(page);
  expect(await player(page)).toEqual({ t: 0, paused: true });
  await word(page, 2).click();                                   // "four", 4 s
  await expect.poll(async () => (await player(page)).t).toBeCloseTo(4, 1);
  expect((await player(page)).paused).toBe(true);
  await expect(word(page, 2)).toHaveClass(/active/);
  await word(page, 0).click();                                   // back to "two"
  await expect.poll(async () => (await player(page)).t).toBeCloseTo(2, 1);
});

test('while the media plays, a click only places the caret (#797)', async ({ page }) => {
  await load(page);
  await page.evaluate(() => document.getElementById('hyperplayer').play());
  await expect.poll(async () => (await player(page)).paused).toBe(false);
  await word(page, 4).click();                                   // "six", 6 s: not taken
  await page.waitForTimeout(300);
  const after = await player(page);
  expect(after.paused).toBe(false);
  expect(after.t).toBeLessThan(5);
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('hypertranscript');
});

test('the setting off, a click leaves the playhead alone (#797)', async ({ page }) => {
  await load(page);
  // switched off where the user does it, on the Playback tab: on by default
  await page.evaluate(() => { document.getElementById('settings-modal').checked = true; });
  await page.click('#settings-tab-playback');
  await expect(page.locator('#setting-click-moves-playhead')).toBeChecked();
  await page.locator('#setting-click-moves-playhead').uncheck();
  expect(await page.evaluate(() => window.HyperaudioSettings.get('clickMovesPlayhead'))).toBe(false);
  await page.evaluate(() => { document.getElementById('settings-modal').checked = false; });
  await word(page, 2).click();
  await page.waitForTimeout(300);
  expect(await player(page)).toEqual({ t: 0, paused: true });
  // the stored choice survives a reload, and the toggle shows it
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(() => { document.getElementById('settings-modal').checked = true; });
  await page.click('#settings-tab-playback');
  await expect(page.locator('#setting-click-moves-playhead')).not.toBeChecked();
});

test('a drag that ends on a word is a selection, not a click (#797)', async ({ page }) => {
  await load(page);
  const from = await word(page, 1).boundingBox();
  const to = await word(page, 3).boundingBox();
  await page.mouse.move(from.x + 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => getSelection().isCollapsed)).toBe(false);
  expect((await player(page)).t).toBe(0);
});

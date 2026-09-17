// #639 — the caption editor said nothing about whether a cue can be read in
// the time it is on screen. Each caption now carries its reading rate, in
// characters per second (the streaming convention) or words per minute (the
// broadcast one), and it is recomputed on every edit.
import { test, expect } from '@playwright/test';

const openCaptions = async (page) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
};

const rates = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#captions-display .caption .caption-rate')].map((el) => el.textContent));

const firstCaption = '#captions-display .caption:first-child';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('every caption shows a rate, in characters per second by default (#639)', async ({ page }) => {
  await openCaptions(page);
  const shown = await rates(page);
  expect(shown.length).toBeGreaterThan(3);
  shown.forEach((r) => expect(r).toMatch(/^\d+(\.\d)? cps$/));
  // and it is the real arithmetic, not a placeholder
  const computed = await page.evaluate(() => {
    const cap = document.querySelector('#captions-display .caption');
    const secs = (v) => { const m = /^(\d+):(\d+):(\d+)[.,](\d+)$/.exec(v.trim()); return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000; };
    const text = [cap.querySelector('.line1').value.trim(), cap.querySelector('.line2').value.trim()].filter((s) => s !== '').join(' ');
    const d = secs(cap.querySelector('.end').value) - secs(cap.querySelector('.start').value);
    return { expected: (text.length / d).toFixed(1) + ' cps', shown: cap.querySelector('.caption-rate').textContent };
  });
  expect(computed.shown).toBe(computed.expected);
});

test('the measure follows the setting, and switching updates what is on screen (#639)', async ({ page }) => {
  await openCaptions(page);
  expect((await rates(page))[0]).toMatch(/cps$/);

  await page.evaluate(() => {
    const m = document.getElementById('settings-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
    // the sections collapse now; a test reaching a control has to open it,
    // as a user does
    document.querySelectorAll('#settings-modal + .modal details').forEach((d) => { d.open = true; });
  });
  await page.selectOption('#setting-caption-rate', 'wpm');
  await expect.poll(async () => (await rates(page))[0]).toMatch(/^\d+ wpm$/);

  // and it is remembered
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hyperaudioSettings')).captionRate)).toBe('wpm');
});

test('editing a line recalculates that caption (#639)', async ({ page }) => {
  await openCaptions(page);
  const before = (await rates(page))[0];
  await page.fill(`${firstCaption} .line1`, 'Short');
  await page.fill(`${firstCaption} .line2`, '');
  await expect.poll(async () => (await rates(page))[0]).not.toBe(before);
  const after = (await rates(page))[0];
  expect(Number(after.split(' ')[0])).toBeLessThan(Number(before.split(' ')[0]));
});

test('changing the out time recalculates it too (#639)', async ({ page }) => {
  await openCaptions(page);
  const before = Number((await rates(page))[0].split(' ')[0]);
  // give the caption far more time: the same words read far more slowly
  await page.fill(`${firstCaption} .end`, '00:01:00.000');
  await expect.poll(async () => Number((await rates(page))[0].split(' ')[0])).toBeLessThan(before);
});

test('merging two captions recalculates the survivor (#639)', async ({ page }) => {
  await openCaptions(page);
  const countBefore = (await rates(page)).length;
  const before = (await rates(page))[0];
  await page.click(`${firstCaption} button:has-text("merge")`);
  await expect.poll(async () => (await rates(page)).length).toBe(countBefore - 1);
  expect((await rates(page))[0]).not.toBe(before);
  expect((await rates(page))[0]).toMatch(/cps$/);
});

test('a caption with no duration or no words shows nothing rather than a nonsense (#639)', async ({ page }) => {
  await openCaptions(page);
  await page.fill(`${firstCaption} .end`, `${await page.inputValue(`${firstCaption} .start`)}`);
  await expect.poll(async () => (await rates(page))[0]).toBe('');

  await page.fill(`${firstCaption} .end`, '00:00:09.000');
  await page.fill(`${firstCaption} .line1`, '');
  await page.fill(`${firstCaption} .line2`, '');
  await expect.poll(async () => (await rates(page))[0]).toBe('');

  // a half-typed timecode is not an error either
  await page.fill(`${firstCaption} .line1`, 'Some words here');
  await page.fill(`${firstCaption} .end`, '00:00:0');
  await expect.poll(async () => (await rates(page))[0]).toBe('');
});

test('clicking a rate switches the measure for every caption (#639)', async ({ page }) => {
  await openCaptions(page);
  const before = await rates(page);
  before.forEach((r) => expect(r).toMatch(/cps$/));

  await page.click(`${firstCaption} .caption-rate`);
  await expect.poll(async () => (await rates(page))[0]).toMatch(/^\d+ wpm$/);
  // all of them, not just the one clicked: it is one editorial standard
  (await rates(page)).forEach((r) => expect(r).toMatch(/wpm$/));
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hyperaudioSettings')).captionRate)).toBe('wpm');

  await page.click(`${firstCaption} .caption-rate`);
  await expect.poll(async () => (await rates(page))[0]).toMatch(/cps$/);

  // and the tooltip says what a click will do
  expect(await page.getAttribute(`${firstCaption} .caption-rate`, 'title'))
    .toMatch(/click to show words per minute$/);
});

test('the Settings choice includes None, which hides the rates (#639)', async ({ page }) => {
  await openCaptions(page);
  expect(await page.evaluate(() =>
    [...document.querySelectorAll('#setting-caption-rate option')].map((o) => o.value)))
    .toEqual(['cps', 'wpm', 'none']);

  await page.evaluate(() => {
    const m = document.getElementById('settings-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
    // the sections collapse now; a test reaching a control has to open it,
    // as a user does
    document.querySelectorAll('#settings-modal + .modal details').forEach((d) => { d.open = true; });
  });
  await page.selectOption('#setting-caption-rate', 'none');
  await expect.poll(async () => page.evaluate(() =>
    [...document.querySelectorAll('#captions-display .caption-rate')].every((el) => el.hidden))).toBe(true);

  // and back again
  await page.selectOption('#setting-caption-rate', 'cps');
  await expect.poll(async () => (await rates(page))[0]).toMatch(/cps$/);
});

test('the choice survives a reload, None included (#639)', async ({ page }) => {
  await page.evaluate(() => window.HyperaudioSettings.set('captionRate', 'none'));
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await openCaptions(page);
  expect(await page.evaluate(() =>
    [...document.querySelectorAll('#captions-display .caption-rate')].every((el) => el.hidden))).toBe(true);
});

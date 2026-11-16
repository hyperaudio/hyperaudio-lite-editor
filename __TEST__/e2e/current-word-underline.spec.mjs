// #804 — the current word is underlined in the primary colour, while playing
// and where play resumes once paused, and a double-click that plays from a
// word (the double-click-to-play setting) selects nothing, since the
// underline marks the word instead. With the setting off a double-click
// selects its word as before.
import { test, expect, webkit, chromium } from '@playwright/test';
import { transcriptHtml } from './helpers.mjs';

const WORDS = Array.from({ length: 12 }, (_, i) => [i * 1000, 1000, 0, 'speech']);

const setup = async (page, playOnDoubleClick) => {
  await page.goto('http://localhost:4173/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate((on) => window.HyperaudioSettings.set('playOnDoubleClick', on), playOnDoubleClick);
  await page.evaluate((html) => { document.getElementById('hypertranscript').innerHTML = html; }, transcriptHtml(WORDS));
};
const word = (page, i) => page.locator('#hypertranscript [data-m]').nth(i);
const selection = (page) => page.evaluate(() => ({ text: getSelection().toString(), collapsed: getSelection().isCollapsed }));

for (const [name, engine] of [['WebKit', webkit], ['Chromium', chromium]]) {
  test(`${name}: a double-click that plays selects nothing; with the setting off it selects its word (#804)`, async () => {
    const browser = await engine.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await setup(page, true);
      await word(page, 5).dblclick();
      await page.waitForTimeout(200);
      expect(await selection(page)).toEqual({ text: '', collapsed: true });
      // nothing selected, so no selection bar
      await expect(page.locator('#selection-menu')).toHaveCount(0);

      await page.evaluate(() => window.HyperaudioSettings.set('playOnDoubleClick', false));
      await word(page, 7).dblclick();
      await page.waitForTimeout(200);
      const off = await selection(page);
      expect(off.collapsed).toBe(false);
      expect(off.text.trim()).toBe('speech');
    } finally {
      await browser.close();
    }
  });
}

test('the current word is underlined in the primary colour, and the line never reaches a saved file (#804)', async ({ page }) => {
  await setup(page, false);
  // a paused click on a word moves the playhead there and marks it (#797)
  await word(page, 4).click();
  await expect(word(page, 4)).toHaveClass(/\bactive\b/);
  const style = await word(page, 4).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { image: cs.backgroundImage, size: cs.backgroundSize, position: cs.backgroundPosition };
  });
  expect(style.image).toContain('linear-gradient');
  expect(style.size).toBe('100% 2px');
  expect(style.position).toMatch(/^0(px|%) 100%$/);
  // other words are not underlined
  expect(await word(page, 6).evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
  // a struck word keeps its line-through with the underline beside it
  await word(page, 4).evaluate((el) => { el.style.textDecoration = 'line-through'; });
  const struck = await word(page, 4).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { line: cs.textDecorationLine, image: cs.backgroundImage };
  });
  expect(struck.line).toContain('line-through');
  expect(struck.image).toContain('linear-gradient');
  // the HTML the editor downloads carries no current-word class
  const saved = await page.evaluate(() => serializeTranscriptHtml(document.getElementById('hypertranscript')));
  expect(saved).not.toContain('active');
});

test('a setting on the Playback tab turns the underline off, and back on (#804)', async ({ page }) => {
  await setup(page, false);
  await word(page, 4).click();
  await expect(word(page, 4)).toHaveClass(/\bactive\b/);
  const underlined = () => word(page, 4).evaluate((el) => getComputedStyle(el).backgroundImage.includes('linear-gradient'));
  expect(await underlined()).toBe(true);
  await page.click('#settings-btn');
  await page.click('#settings-tab-playback');
  const toggle = page.locator('#setting-underline-current-word');
  await expect(toggle).toBeChecked();
  await toggle.click();
  expect(await underlined()).toBe(false);
  expect(await page.evaluate(() => window.HyperaudioSettings.get('underlineCurrentWord'))).toBe(false);
  // off survives a reload, with no frame of underline
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  expect(await page.evaluate(() => document.documentElement.classList.contains('ha-no-word-underline'))).toBe(true);
  await page.evaluate(() => window.HyperaudioSettings.set('underlineCurrentWord', true));
});

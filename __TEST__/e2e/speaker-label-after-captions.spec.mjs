// #675 — a typed [speaker] label stayed plain text after a visit to the
// caption editor. The caption editor clones the transcript into its cache and
// puts the clone back on return; a clone carries attributes but not
// listeners, and the input listener that marks transcript maintenance dirty
// was guarded by an attribute, so it was never re-attached. Typing then
// marked nothing dirty, and the sanitise pass that mints the speaker span
// never ran until the next project switch.
import { test, expect } from '@playwright/test';

const typeLabelAtParagraph = async (page, index, label) => {
  await page.evaluate((i) => {
    const word = document.querySelectorAll('#hypertranscript p')[i].querySelector('span[data-m]:not(.speaker)');
    const range = document.createRange(); range.setStart(word.firstChild, 0); range.collapse(true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.getElementById('hypertranscript').focus();
  }, index);
  await page.keyboard.type(label + ' ', { delay: 30 });
};
const labelIsSpeaker = (page, label) => page.evaluate((l) => {
  const span = [...document.querySelectorAll('#hypertranscript span')].find((s) => s.textContent.includes(l));
  return span ? span.classList.contains('speaker') && getComputedStyle(span).fontWeight === '700' : false;
}, label);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForTimeout(1200);   // the initial sanitise pass
});

test('a [speaker] typed after a caption-editor round trip becomes bold (#675)', async ({ page }) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
  await page.click('#transcript-editor-btn');
  await page.waitForSelector('#hypertranscript [data-m]');
  // let the pass the view switch itself queues run, so only typing can mint the label
  await page.waitForTimeout(4500);

  await typeLabelAtParagraph(page, 1, '[Zoe]');
  await expect.poll(() => labelIsSpeaker(page, '[Zoe]'), { timeout: 8000 }).toBe(true);

  // and again, twice round: the guard has to hold for every clone
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
  await page.click('#transcript-editor-btn');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForTimeout(4500);
  await typeLabelAtParagraph(page, 2, '[Yusuf]');
  await expect.poll(() => labelIsSpeaker(page, '[Yusuf]'), { timeout: 8000 }).toBe(true);
});

test('typing still marks maintenance dirty after the round trip (#675)', async ({ page }) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
  await page.click('#transcript-editor-btn');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForTimeout(4500);
  expect((await page.evaluate(() => window.hyperaudioInspectTranscriptMaintenance().local)).dirty).toBe(false);
  await typeLabelAtParagraph(page, 1, 'hello');
  // seen at once, before the debounce runs it
  expect((await page.evaluate(() => window.hyperaudioInspectTranscriptMaintenance().local)).dirty).toBe(true);
});

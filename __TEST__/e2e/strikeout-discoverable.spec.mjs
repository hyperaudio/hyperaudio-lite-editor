// #794 — strikeout is how media is cut, and users did not find it. The button
// now says so, ⌘⇧X / Ctrl+Shift+X strikes the selection, and the first
// keyboard deletion of a whole timed word gets a one-time hint. Also #679:
// the greyed button explains itself.
import { test, expect } from '@playwright/test';

const vtt = (page) => page.evaluate(() => window.HyperaudioSave.getCaptionsVtt());

// select words i..j of the transcript (speaker labels aside)
const select = (page, i, j) => page.evaluate(([a, b]) => {
  const spans = document.querySelectorAll('#hypertranscript [data-m]:not(.speaker)');
  const r = document.createRange();
  r.setStart(spans[a].firstChild, 0);
  r.setEnd(spans[b].firstChild, spans[b].textContent.trimEnd().length);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  document.getElementById('hypertranscript').focus();
  return [...spans].slice(a, b + 1).map((sp) => sp.textContent.trim());
}, [i, j]);

const struck = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#hypertranscript [data-m]')]
    .filter((s) => (s.style.textDecoration || '').includes('line-through'))
    .map((s) => s.textContent.trim()));

const shortcut = async (page) => {
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await page.keyboard.press(mac ? 'Meta+Shift+x' : 'Control+Shift+x');
};

const btn = (page) => page.locator('#strikethrough');
const dialog = (page) => page.locator('#project-dialog.modal-open');

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => vtt(page)).toContain('Hyperaudio Lite Editor');
});

test('the button says what it does, and why it is grey (#794, #679)', async ({ page }) => {
  await expect(btn(page)).toHaveClass(/btn-disabled/);
  await expect(btn(page)).toHaveAttribute('data-tip', 'Select words to cut from audio and video');
  await expect(btn(page)).toHaveAttribute('aria-label', /Cut the selected words from the audio and video/);
  // greyed, it still takes the pointer, so the tooltip can show
  expect(await btn(page).evaluate((b) => getComputedStyle(b).pointerEvents)).toBe('auto');

  await select(page, 2, 2);
  await expect(btn(page)).not.toHaveClass(/btn-disabled/);
  await expect(btn(page)).toHaveAttribute('data-tip', /^Cut from audio and video \(strike out, (⌘⇧X|Ctrl\+Shift\+X)\)$/);
});

test('⌘⇧X strikes the selection and strikes it back, captions following (#794)', async ({ page }) => {
  expect(await select(page, 2, 4)).toEqual(['Lite', 'Editor', 'makes']);
  await shortcut(page);
  expect(await struck(page)).toEqual(['Lite', 'Editor', 'makes']);
  await expect.poll(() => vtt(page)).not.toContain('Lite Editor');

  await select(page, 2, 4);
  await shortcut(page);
  expect(await struck(page)).toEqual([]);
  await expect.poll(() => vtt(page)).toContain('Hyperaudio Lite Editor');
});

test('the shortcut leaves a text field alone', async ({ page }) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
  const box = page.locator('#captions-display .caption:first-child .lines');
  await box.click();
  await page.keyboard.press('Control+a');
  await shortcut(page);
  await page.click('#transcript-editor-btn');
  await page.waitForSelector('#hypertranscript [data-m]');
  expect(await struck(page)).toEqual([]);
});

test('deleting a whole word gets the hint once, and "Don\'t tell me again" keeps it away (#794)', async ({ page }) => {
  await select(page, 2, 2);                               // "Lite"
  await page.keyboard.press('Backspace');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('#project-dialog-title')).toContainText('Deleted from the text, not the media');
  await expect(dialog(page).locator('#project-dialog-message')).toContainText(/strike them out \((⌘⇧X|Ctrl\+Shift\+X)\)/);
  // the deletion itself went ahead: the hint explains, it does not block
  // ("Lite" comes round again later, in "Hyperaudio Lite Library")
  await expect.poll(() => page.evaluate(() => document.querySelector('#hypertranscript').textContent.replace(/\s+/g, ' ').trim().slice(0, 40))).not.toContain('Lite');

  await page.click('#project-dialog-confirm');            // OK: this visit only
  await expect(dialog(page)).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('noStrikeHint'))).toBeNull();
  await select(page, 2, 2);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await expect(dialog(page)).not.toBeVisible();           // once per visit

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await select(page, 2, 2);
  await page.keyboard.press('Backspace');
  await expect(dialog(page)).toBeVisible();
  await page.click('#project-dialog-cancel');             // Don't tell me again
  await expect(dialog(page)).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('noStrikeHint'))).toBe('true');

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await select(page, 2, 2);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await expect(dialog(page)).not.toBeVisible();
});

test('a one-character deletion gets no hint (#794)', async ({ page }) => {
  await page.locator('#hypertranscript span[data-m]:not(.speaker)').nth(3).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await expect(dialog(page)).not.toBeVisible();
});

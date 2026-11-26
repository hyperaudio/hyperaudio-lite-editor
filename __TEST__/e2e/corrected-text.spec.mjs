// #845 — Corrected text: a project's words replaced by corrected ones, each
// keeping the time of the word it matches. Reached from a project's ⋮ menu
// in Recents and from File ▸ Corrected text…. Text without speaker labels
// keeps the project's speakers and paragraphs, unchanged words keep their
// strike-out, a caption file's captions become the project's, and the
// replacement is one undo step.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const words = (page) => page.evaluate(() => [...document.querySelectorAll('#hypertranscript [data-m]')]
  .filter((s) => !s.classList.contains('speaker'))
  .map((s) => ({ text: s.textContent.trim(), m: Number(s.dataset.m), struck: /line-through/.test(s.getAttribute('style') || '') })));
const speakers = (page) => page.evaluate(() => [...document.querySelectorAll('#hypertranscript .speaker')].map((s) => s.textContent.trim()));
const paragraphCount = (page) => page.evaluate(() => document.querySelectorAll('#hypertranscript p').length);
// the project's own words, a paragraph a line, with no speaker labels
const plainText = (page) => page.evaluate(() => [...document.querySelectorAll('#hypertranscript p')]
  .map((p) => [...p.querySelectorAll('[data-m]:not(.speaker)')].map((s) => s.textContent.trim()).join(' ')).join('\n'));

const strikeThird = async (page) => {
  await page.evaluate(() => {
    const w = [...document.querySelectorAll('#hypertranscript [data-m]:not(.speaker)')][2];
    const range = document.createRange();
    range.selectNodeContents(w);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.click('#strikethrough');
  await expect.poll(async () => (await words(page))[2].struck).toBe(true);
};

const openFromFileMenu = (page) => page.evaluate(() => document.getElementById('upload-align-btn').click());
const projects = (page) => page.evaluate(async () => (await window.HyperaudioSave.library.list()).length);

const replaceFromMenu = async (page, text) => {
  await openFromFileMenu(page);
  await expect(page.locator('#align-modal')).toBeChecked();
  await page.fill('#align-text-input', text);
  await page.click('#align-text-btn');
  await expect(page.locator('#project-dialog.modal-open')).toBeVisible();
  const message = await page.locator('#project-dialog').textContent();
  await page.click('#project-dialog-confirm');
  await expect(page.locator('#align-modal')).not.toBeChecked();
  return message;
};

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(async () => (await window.HyperaudioSave.library.list()).length)).toBe(1);
});

test('text without speaker labels keeps the speakers, paragraphs and strike-outs, and each word its time', async ({ page }) => {
  await strikeThird(page);
  const before = await words(page);
  const beforeSpeakers = await speakers(page);
  const beforeParagraphs = await paragraphCount(page);
  expect(beforeSpeakers.length).toBeGreaterThan(0);

  // one word changed, one added, one taken out, and a line starting
  // "Note:" that is not a speaker
  const text = (await plainText(page))
    .replace('makes', 'turns')
    .replace(/\baudio\b/, 'audio, sound')
    .replace(' video ', ' ') + '\nNote: the end';
  const message = await replaceFromMenu(page, text);
  expect(message).toContain('How to use the Editor');
  expect(message).toContain('speaker names and struck-out words');

  const after = await words(page);
  const texts = after.map((w) => w.text);
  expect(texts).toContain('turns');
  expect(texts).toContain('sound');
  expect(texts).toContain('Note:');
  // an unchanged word keeps its time, and a changed one takes the old one's
  const at = (list, word) => list.find((w) => w.text === word).m;
  expect(at(after, 'Editor')).toBe(at(before, 'Editor'));
  expect(at(after, 'turns')).toBe(at(before, 'makes'));
  expect(after[2].struck).toBe(true);
  expect(await projects(page)).toBe(1);
  expect(await speakers(page)).toEqual(beforeSpeakers);
  expect(await paragraphCount(page)).toBe(beforeParagraphs);
  await expect(page.locator('#project-save-btn')).toHaveClass(/dirty/);

  // one undo step: the old words come back and the strike made before stays
  await page.click('#hypertranscript p');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(async () => (await words(page)).map((w) => w.text)).toEqual(before.map((w) => w.text));
  expect((await words(page))[2].struck).toBe(true);
});

test('text with speaker labels brings its own speakers and paragraphs', async ({ page }) => {
  const lines = (await plainText(page)).split('\n');
  const text = `[Ann] ${lines.slice(0, 2).join(' ')}\n[Ben] ${lines.slice(2).join(' ')}`;
  const message = await replaceFromMenu(page, text);
  expect(message).toContain('words and speaker names');
  expect(await speakers(page)).toEqual(['[Ann]', '[Ben]']);
  expect(await paragraphCount(page)).toBe(2);
});

test('a caption file\'s words replace the words, and its captions become the project\'s', async ({ page }, testInfo) => {
  const before = await words(page);
  // the project's first ten words as two cues, at times of the file's own
  const first = before.slice(0, 10).map((w) => w.text);
  const srt = `1\n00:00:00,500 --> 00:00:02,000\n${first.slice(0, 5).join(' ')}\n\n2\n00:00:02,000 --> 00:00:04,000\n${first.slice(5).join(' ')}\n`;
  const file = testInfo.outputPath('corrected.srt');
  fs.writeFileSync(file, srt);

  await openFromFileMenu(page);
  await page.setInputFiles('#align-file-input', file);
  await page.click('#align-text-btn');
  const message = await page.locator('#project-dialog').textContent();
  expect(message).toContain('replaced by the file’s captions');
  await page.click('#project-dialog-confirm');

  // the words keep the project's times, not the file's
  const after = await words(page);
  expect(after.slice(0, 10).map((w) => w.m)).toEqual(before.slice(0, 10).map((w) => w.m));
  expect(await projects(page)).toBe(1);
  // the captions are the file's two cues, still so after the deferred caption
  // pass, and after a save and a reload
  await page.waitForTimeout(4000);
  expect(await page.evaluate(() => window.HyperaudioSave.getCaptionsVtt())).toContain('00:00:00.500 --> 00:00:02.000');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await expect(page.locator('#project-save-btn')).not.toHaveClass(/dirty/);
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.click('#caption-editor-btn');
  const divergence = page.locator('#project-dialog.modal-open');
  if (await divergence.isVisible()) await page.click('#project-dialog-confirm');
  await expect(page.locator('#captions-display .caption')).toHaveCount(2);
  await expect(page.locator('#captions-display .caption').first().locator('.start')).toHaveValue('00:00:00.500');
});

test('a struck-out word the text leaves out stays, still struck out', async ({ page }) => {
  await strikeThird(page);
  const struckWord = (await words(page))[2];
  const lines = (await plainText(page)).split('\n');
  lines[0] = lines[0].split(' ').filter((w, i) => i !== 2).join(' ');
  await replaceFromMenu(page, lines.join('\n'));
  const kept = (await words(page)).find((w) => w.m === struckWord.m && w.text === struckWord.text);
  expect(kept).toBeTruthy();
  expect(kept.struck).toBe(true);
});

test('the Recents ⋮ menu opens the dialog for that project, and a caption file pasted as text is read as one', async ({ page }) => {
  // another project open first, so the menu has to open this one
  await page.evaluate(() => { document.getElementById('file-import-srt-dialog').checked = true; });
  await page.setInputFiles('#srt', { name: 'other.srt', mimeType: 'application/x-subrip',
    buffer: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nSomething else\n') });
  await page.click('#file-import-srt');
  await expect.poll(() => projects(page)).toBe(2);
  await expect(page.locator('#hypertranscript')).toContainText('Something else');

  const item = page.locator('#file-picker .file-item[data-id]', { hasText: 'How to use the Editor' });
  await item.hover();
  await item.locator('..').locator('.recents-kebab').click();
  await page.click('#recents-menu .recents-menu-corrected');
  await expect(page.locator('#align-modal')).toBeChecked();
  await expect(page.locator('#align-project-name')).toHaveText('How to use the Editor');
  await expect(page.locator('#hypertranscript')).not.toContainText('Something else');

  const kinds = await page.evaluate(() => {
    const k = window.hyperaudioCorrectedTextParts.kindOf;
    return [k('WEBVTT\n\n00:01.000 --> 00:02.000\nhi'), k('1\n00:00:01,000 --> 00:00:02,000\nhi'), k('1 apple\n2 pears')];
  });
  expect(kinds).toEqual(['vtt', 'srt', 'text']);
  expect(await page.evaluate(() => window.hyperaudioCorrectedTextParts.hasSpeakerLabels('Note: this is fine'))).toBe(false);
});

// #842 — a WebVTT file can time each word inside a cue with inline
// timestamps, and the editor's own word-level download is written that way.
// Importing one put the timestamps into the transcript as text and spread
// each cue's time evenly over its words. The words take the file's times
// now, and the captions are kept without the timestamps.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const words = (page) => page.evaluate(() => [...document.querySelectorAll('#hypertranscript [data-m]')]
  .filter((s) => !s.classList.contains('speaker') && s.textContent.trim() !== '')
  .map((s) => [s.textContent.trim(), Number(s.getAttribute('data-m'))]));

test('the editor\'s word-level download imports with each word at its own time', async ({ page }, testInfo) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const before = await words(page);
  const file = await page.evaluate(() => window.generateWordVtt());
  expect(file).toMatch(/<\d{2}:\d{2}:\d{2}\.\d{3}><c>/);

  const path = testInfo.outputPath('talk.words.vtt');
  fs.writeFileSync(path, file);
  await page.evaluate(() => { document.getElementById('file-import-vtt-dialog').checked = true; });
  // the old transcript's first word, to know when the import has replaced it
  await page.evaluate(() => { window.__oldWord = document.querySelector('#hypertranscript [data-m]'); });
  await page.setInputFiles('#vtt', path);
  await page.click('#file-import-vtt');
  await page.waitForFunction(() => window.__oldWord && !window.__oldWord.isConnected);
  await expect(page.locator('#hypertranscript')).not.toContainText('<c>');
  expect(await page.evaluate(() => /\d{2}:\d{2}\.\d{3}/.test(document.getElementById('hypertranscript').textContent))).toBe(false);

  // every word back at its own start, to the millisecond the file holds
  const after = await words(page);
  expect(after.length).toBeGreaterThan(20);
  expect(after).toEqual(before);

  // and the Captions view shows the words without timestamps or tags
  await page.click('#caption-editor-btn');
  const divergence = page.locator('#project-dialog.modal-open');
  if (await divergence.isVisible()) await page.click('#project-dialog-confirm');
  await page.waitForSelector('#captions-display .caption');
  const text = await page.evaluate(() => [...document.querySelectorAll('#captions-display .lines')].map((l) => l.value).join(' '));
  expect(text).not.toMatch(/<\d|<\/?c[.>]/);
  expect(text).toContain(after[0][0]);
});

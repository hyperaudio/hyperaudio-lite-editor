// #637 — the caption and HTML download links carried a fixed name in the
// markup, so every project's captions arrived as hyperaudio.vtt while the
// document and media exports already used the project's title.
import { test, expect } from '@playwright/test';

const names = (page) => page.evaluate(() =>
  ['download-vtt', 'download-vtt-words', 'download-srt', 'download-html']
    .map((id) => document.getElementById(id).getAttribute('download')));

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.library.currentId())).not.toBeNull();
});

test('downloads are named after the project (#637)', async ({ page }) => {
  // the intro project, whose title is its own
  await expect.poll(() => names(page)).toEqual([
    'How_to_use_the_Editor.vtt',
    'How_to_use_the_Editor.words.vtt',
    'How_to_use_the_Editor.srt',
    'How_to_use_the_Editor.html',
  ]);
});

test('a rename follows through to the filenames (#637)', async ({ page }) => {
  await page.evaluate(async () => {
    const lib = window.HyperaudioSave.library;
    await lib.rename(lib.currentId(), 'Maria: interview / take 2');
  });
  // punctuation that is hostile in a path or a URL is stripped, as elsewhere
  await expect.poll(() => names(page)).toEqual([
    'Maria_interview_take_2.vtt',
    'Maria_interview_take_2.words.vtt',
    'Maria_interview_take_2.srt',
    'Maria_interview_take_2.html',
  ]);
});

test('an untitled project keeps the names the markup gives (#637)', async ({ page }) => {
  await page.evaluate(async () => {
    const lib = window.HyperaudioSave.library;
    await lib.rename(lib.currentId(), '');
    document.getElementById('download-vtt').dispatchEvent(new Event('click', { bubbles: true }));
  });
  const got = await names(page);
  expect(got[0].endsWith('.vtt')).toBe(true);
  expect(got.every((n) => n !== null && n !== '')).toBe(true);
});

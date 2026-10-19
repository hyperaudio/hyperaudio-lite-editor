// #743 — a caption import places paragraphs by the same rule as every engine:
// a new paragraph only at a sentence end, after a real pause of more than 4 s
// (the silence between one cue's end and the next one's start) or past 100
// words. A slow cue spreads its words out, but that is not a pause.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const importVtt = async (page, testInfo, vttText) => {
  const vtt = testInfo.outputPath('talk.vtt');
  fs.writeFileSync(vtt, vttText);
  await page.evaluate(() => { document.getElementById('file-import-vtt-dialog').checked = true; });
  await page.setInputFiles('#vtt', vtt);
  await page.click('#file-import-vtt');
  await page.waitForFunction(() => document.getElementById('hypertranscript').textContent.includes('One'));
  return page.evaluate(() => [...document.querySelectorAll('#hypertranscript p')].map((p) => p.textContent.trim()));
};

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('a VTT breaks at a sentence end after more than 4 s of silence between cues, and nowhere else', async ({ page }, testInfo) => {
  const paragraphs = await importVtt(page, testInfo, 'WEBVTT\n\n'
    + '00:00:00.000 --> 00:00:02.000\nOne two three.\n\n'
    + '00:00:07.000 --> 00:00:09.000\nFour five six\n\n'          // 5 s of silence after a sentence end: a break
    + '00:00:15.000 --> 00:00:17.000\nseven eight nine.\n\n'      // 6 s of silence, but mid-sentence: no break
    + '00:00:18.000 --> 00:00:30.000\nTen eleven.\n');            // a slow cue (6 s per word) is not a pause
  expect(paragraphs).toEqual(['One two three.', 'Four five six seven eight nine. Ten eleven.']);
});

test('an SRT places its paragraphs by the same rule', async ({ page }, testInfo) => {
  const srt = testInfo.outputPath('talk.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\nOne two three.\n\n'
    + '2\n00:00:07,000 --> 00:00:09,000\nFour five six\n\n'
    + '3\n00:00:15,000 --> 00:00:17,000\nseven eight nine.\n\n'
    + '4\n00:00:18,000 --> 00:00:30,000\nTen eleven.\n');
  await page.evaluate(() => { document.getElementById('file-import-srt-dialog').checked = true; });
  await page.setInputFiles('#srt', srt);
  await page.click('#file-import-srt');
  await page.waitForFunction(() => document.getElementById('hypertranscript').textContent.includes('One'));
  const paragraphs = await page.evaluate(() => [...document.querySelectorAll('#hypertranscript p')].map((p) => p.textContent.trim()));
  expect(paragraphs).toEqual(['One two three.', 'Four five six seven eight nine. Ten eleven.']);
});

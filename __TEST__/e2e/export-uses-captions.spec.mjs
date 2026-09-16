// #634 — exports used to regenerate captions from the transcript, and to
// re-chunk it again by different rules for burn-in, so curated cues reached
// neither the sidecar files nor the picture and the two disagreed with each
// other. Both come from the caption track now. Cue TEXT is never rewritten;
// only the times move onto the edited timeline.
import { test, expect } from '@playwright/test';

const VTT = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:03.000',
  'The first line here',
  'and its second line',
  '',
  '00:00:05.000 --> 00:00:07.000',
  'A later cue',
  '',
].join('\n');

// Put a caption track on the player, as the caption editor does.
const setCaptions = (page, vtt) => page.evaluate((vtt) => {
  document.getElementById('hyperplayer-vtt').src = 'data:text/vtt,' + encodeURIComponent(vtt);
}, vtt);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForFunction(() => typeof window.MediaExportCaptions === 'object');
});

test('cues are parsed with their line breaks intact (#634)', async ({ page }) => {
  const cues = await page.evaluate((vtt) => window.MediaExportCaptions.parseVttCues(vtt), VTT);
  expect(cues).toEqual([
    { start: 1, end: 3, lines: ['The first line here', 'and its second line'] },
    { start: 5, end: 7, lines: ['A later cue'] },
  ]);
});

test('an unedited export ships the cues exactly as they are (#634)', async ({ page }) => {
  await setCaptions(page, VTT);
  const subs = await page.evaluate(() => {
    const whole = [{ start: 0, end: 600 }];          // Entire media: one section
    return window.MediaExportCaptions.genRetimedCaptions(whole, 1, false);
  });
  expect(subs.vtt).toContain('The first line here\nand its second line');
  expect(subs.vtt).toContain('00:00:01.000 --> 00:00:03.000');
  expect(subs.srt).toContain('1\n00:00:01,000 --> 00:00:03,000');
  expect(subs.srt).toContain('A later cue');
});

test('an edited export moves the times and leaves the words alone (#634)', async ({ page }) => {
  await setCaptions(page, VTT);
  const subs = await page.evaluate(() => {
    // seconds 3..5 are cut, so the later cue slides two seconds earlier
    const sections = [{ start: 0, end: 3 }, { start: 5, end: 600 }];
    return window.MediaExportCaptions.genRetimedCaptions(sections, 1, true);
  });
  expect(subs.vtt).toContain('00:00:01.000 --> 00:00:03.000');   // first cue unmoved
  expect(subs.vtt).toContain('00:00:03.000 --> 00:00:05.000');   // second slid by the cut
  expect(subs.vtt).toContain('A later cue');                     // text untouched
});

test('a cue whose words were all cut away is dropped (#634)', async ({ page }) => {
  await setCaptions(page, VTT);
  const subs = await page.evaluate(() => {
    const sections = [{ start: 0, end: 3 }, { start: 7, end: 600 }];   // 3..7 gone
    return window.MediaExportCaptions.genRetimedCaptions(sections, 1, true);
  });
  expect(subs.vtt).toContain('The first line here');
  expect(subs.vtt).not.toContain('A later cue');
});

test('the playback rate divides the cue times (#634)', async ({ page }) => {
  await setCaptions(page, VTT);
  const subs = await page.evaluate(() =>
    window.MediaExportCaptions.genRetimedCaptions([{ start: 0, end: 600 }], 2, false));
  expect(subs.vtt).toContain('00:00:00.500 --> 00:00:01.500');
});

test('burn-in chunks carry the cue\'s lines and its in and out times (#634)', async ({ page }) => {
  await setCaptions(page, VTT);
  const chunks = await page.evaluate(() =>
    window.MediaExportCaptions.buildCaptionChunks([{ start: 0, end: 600 }], 1, false));
  expect(chunks).toHaveLength(2);
  expect(chunks[0].start).toBe(1);
  expect(chunks[0].end).toBe(3);
  expect(chunks[0].lines.map((l) => l.map((wd) => wd.text).join(' ')))
    .toEqual(['The first line here', 'and its second line']);
  // every word has a time inside the cue, so the read-along can track
  const times = chunks[0].lines.flat().map((wd) => wd.start);
  expect(Math.min(...times)).toBeGreaterThanOrEqual(1);
  expect(Math.max(...times)).toBeLessThan(3);
  expect([...times].sort((a, b) => a - b)).toEqual(times);
});

test('with no captions at all, burn-in still falls back to the word chunker (#634)', async ({ page }) => {
  await page.evaluate(() => { document.getElementById('hyperplayer-vtt').src = ''; });
  const chunks = await page.evaluate(() =>
    window.MediaExportCaptions.buildCaptionChunks([{ start: 0, end: 600 }], 1, false));
  expect(Array.isArray(chunks)).toBe(true);
  expect(chunks.length).toBeGreaterThan(0);
  expect(Array.isArray(chunks[0])).toBe(true);        // the old format: a bare array of words
});

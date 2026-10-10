// #720 — burned-in captions drifted from the speech in clip and sped-up
// exports. The retimed transcript's words are whole milliseconds; the retimed
// cues were raw floats, so a cue's end could sit a few microseconds above the
// next cue's first word, which then counted as the earlier cue's one word too
// many, and that cue lost its word times to the syllable spread.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('a boundary word a few microseconds under the cue end is the next cue\'s, and the cue keeps its word times', async ({ page }) => {
  const chunks = await page.evaluate(() => {
    const cue = { start: 11.2, end: 14.495327102803735, lines: ['I focus primarily on', 'neuroscience research.'] };
    const words = [11.2, 11.5, 12.1, 12.9, 13.2, 13.9, 14.495].map((start, i) => ({ start, text: 'w' + i }));
    return window.MediaExportCaptions.cuesToChunks([cue], words);
  });
  // from the words, not spread by syllable: 'neuroscience' would otherwise
  // take a long share of the cue's span
  const starts = chunks[0].lines.flat().map((w) => w.start);
  expect(starts).toEqual([11.2, 11.5, 12.1, 12.9, 13.2, 13.9]);
});

test('with the raw float end the same cue fell to the syllable spread, and rounding to milliseconds is what prevents it', async ({ page }) => {
  const r = await page.evaluate(() => {
    const c = window.MediaExportCaptions;
    const cues = [
      { start: 49.37, end: 53.64, lines: ['one two'] },
      { start: 53.64, end: 56.2, lines: ['three four'] },
    ];
    const sections = [{ start: 38.17, end: 597 }];
    const rate = 1.07;
    const retimed = c.retimeCues(cues, sections, rate);
    // the transcript's words, retimed exactly as the export retimes them
    const words = [49.37, 51.0, 53.64, 55.1].map((t, i) => ({
      start: Math.round(((t - 38.17) / rate) * 1000) / 1000, text: 'w' + i,
    }));
    return { retimed, chunks: c.cuesToChunks(retimed, words), words };
  });
  for (const cue of r.retimed) {
    expect(Math.round(cue.start * 1000) / 1000).toBe(cue.start);
    expect(Math.round(cue.end * 1000) / 1000).toBe(cue.end);
  }
  // the first cue's two words are its own two, not the third as well
  expect(r.chunks[0].lines[0].map((w) => w.start)).toEqual([r.words[0].start, r.words[1].start]);
  expect(r.chunks[1].lines[0].map((w) => w.start)).toEqual([r.words[2].start, r.words[3].start]);
});

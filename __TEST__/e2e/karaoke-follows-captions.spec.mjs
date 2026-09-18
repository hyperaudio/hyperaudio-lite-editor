// The word-level ("karaoke") WebVTT chunked the transcript into fives of its
// own, so it put a different set of words on screen from the captions and cut
// across sentences: at 0:50 of a debate the captions read "that it's actually
// a real offer / and option for everybody in this country" while this file
// read "in this country. When I". It also inherited nothing of the captions'
// timing — a chunk ended at its last word's end, so where a transcript packs
// words together the cue flashed for a twenty-fifth of a second.
//
// It is now the caption file with word timings inside it: same cues, same
// lines, same words, each one wrapped so a player can light it as it is
// spoken.
import { test, expect } from '@playwright/test';

const download = async (page, id) => {
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate((linkId) => document.getElementById(linkId).click(), id),
  ]);
  const stream = await dl.createReadStream();
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

const timings = (vtt) => vtt.match(/^\d\d:\d\d:\d\d\.\d\d\d --> \d\d:\d\d:\d\d\.\d\d\d$/gm) || [];
// the words, with every tag removed, so the two files can be compared as text
const spoken = (vtt) => vtt
  .replace(/<[^>]*>/g, '')
  .replace(/^WEBVTT\s*/, '')
  .replace(/^\d\d:\d\d:\d\d\.\d\d\d --> .*$/gm, '')
  .replace(/\s+/g, ' ')
  .trim();

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
});

test('the karaoke file is the caption file, word by word', async ({ page }) => {
  const plain = await download(page, 'download-vtt');
  const karaoke = await download(page, 'download-vtt-words');

  expect(timings(karaoke)).toEqual(timings(plain));   // the same cues, to the millisecond
  expect(spoken(karaoke)).toBe(spoken(plain));        // and the same words
  expect(timings(karaoke).length).toBeGreaterThan(3);

  // every word carries its own timestamp, in order, inside its cue
  const cueBlocks = karaoke.split(/\n{2,}/).filter((b) => b.includes(' --> '));
  expect(cueBlocks.length).toBe(timings(plain).length);
  const secs = (v) => {
    const m = /(\d+):(\d\d):(\d\d)\.(\d+)/.exec(v);
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number('0.' + m[4]);
  };
  cueBlocks.forEach((block) => {
    const [range] = block.match(/^\d\d:\d\d:\d\d\.\d\d\d --> \d\d:\d\d:\d\d\.\d\d\d$/m);
    const [start, end] = range.split(' --> ').map(secs);
    const stamps = [...block.matchAll(/<(\d\d:\d\d:\d\d\.\d\d\d)><c>([^<]*)<\/c>/g)].map((m) => secs(m[1]));
    expect(stamps.length).toBeGreaterThan(0);
    stamps.forEach((t) => {
      expect(t).toBeGreaterThanOrEqual(start - 0.001);
      expect(t).toBeLessThanOrEqual(end + 0.001);
    });
    expect(stamps.slice().sort((a, b) => a - b)).toEqual(stamps);
  });
});

test('the line breaks are the captions\' own', async ({ page }) => {
  const plain = await download(page, 'download-vtt');
  const karaoke = await download(page, 'download-vtt-words');
  const linesPerCue = (vtt) => vtt.split(/\n{2,}/)
    .filter((b) => b.includes(' --> '))
    .map((b) => b.split('\n').filter((l) => l.trim() !== '' && !l.includes(' --> ')).length);
  expect(linesPerCue(karaoke)).toEqual(linesPerCue(plain));
  expect(linesPerCue(karaoke).some((n) => n === 2)).toBe(true);   // and some cues do wrap
});

test('an edited caption is what the karaoke file carries too', async ({ page }) => {
  await page.fill('#captions-display .caption:first-child .line1', 'EDITED LINE');
  await expect.poll(async () => (await download(page, 'download-vtt')).includes('EDITED LINE')).toBe(true);
  const karaoke = await download(page, 'download-vtt-words');
  expect(karaoke).toContain('<c>EDITED</c>');
  expect(karaoke).toContain('<c>LINE</c>');
  expect(timings(karaoke)).toEqual(timings(await download(page, 'download-vtt')));
});

test('with no captions to follow it still produces a file', async ({ page }) => {
  // the fallback: its own chunking of the transcript, as before
  const karaoke = await page.evaluate(() => {
    const save = window.HyperaudioSave;
    const real = save.getCaptionsVtt;
    save.getCaptionsVtt = () => '';
    try { return window.generateWordVtt(); } finally { save.getCaptionsVtt = real; }
  });
  expect(karaoke.startsWith('WEBVTT')).toBe(true);
  expect(timings(karaoke).length).toBeGreaterThan(3);
  expect(karaoke).toMatch(/<\d\d:\d\d:\d\d\.\d\d\d><c>/);
});

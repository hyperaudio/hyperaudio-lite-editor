// The caption download links took their address from the two caption writers
// alone, and neither runs at boot. A freshly opened page handed you an empty
// .vtt and .srt, and a reloaded project an empty .srt, with nothing to say
// anything was wrong. The captions were never missing — the live track has had
// them all along — so both links are now filled from one writer.
import { test, expect } from '@playwright/test';

const hrefLengths = (page) => page.evaluate(() => ({
  vtt: (document.getElementById('download-vtt').getAttribute('href') || '').length,
  srt: (document.getElementById('download-srt').getAttribute('href') || '').length,
  track: (document.getElementById('hyperplayer-vtt').getAttribute('src') || '').length,
}));

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

const cueCount = (text) => (text.match(/ --> /g) || []).length;

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(() =>
    (document.getElementById('hyperplayer-vtt').getAttribute('src') || '').length)).toBeGreaterThan(0);
});

test('a download straight from a freshly opened page carries the captions', async ({ page }) => {
  // nothing has built the caption rows yet: this is the case that was empty
  expect(await page.evaluate(() => document.querySelectorAll('#captions-display .caption').length)).toBe(0);

  const vtt = await download(page, 'download-vtt');
  const srt = await download(page, 'download-srt');
  expect(vtt.startsWith('WEBVTT')).toBe(true);
  expect(cueCount(vtt)).toBeGreaterThan(3);
  expect(srt.startsWith('1\n')).toBe(true);
  expect(cueCount(srt)).toBe(cueCount(vtt));
  // the same cues in the other format, commas for the decimal point
  expect(srt).toMatch(/\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d/);
});

test('a reloaded project has an SRT download, not only a WebVTT one', async ({ page }) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
  await page.evaluate(async () => { await window.HyperaudioSave.saveProject(); });

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(async () => (await hrefLengths(page)).srt).toBeGreaterThan(0);

  const srt = await download(page, 'download-srt');
  const vtt = await download(page, 'download-vtt');
  expect(cueCount(srt)).toBe(cueCount(vtt));
  expect(cueCount(srt)).toBeGreaterThan(3);
});

test('a caption file handed to the editor becomes both downloads', async ({ page }) => {
  // the route a VTT import takes, which wrote neither link before
  await page.evaluate(() => {
    window.populateCaptionEditorFromVtt(
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfirst line\n\n00:00:01.000 --> 00:00:02.000\nsecond line\n');
  });
  const vtt = await download(page, 'download-vtt');
  const srt = await download(page, 'download-srt');
  expect(vtt).toContain('first line');
  expect(srt).toContain('first line');
  expect(cueCount(vtt)).toBe(2);
  expect(cueCount(srt)).toBe(2);
});

test('opening the caption editor still writes both links itself', async ({ page }) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
  const lens = await hrefLengths(page);
  expect(lens.vtt).toBeGreaterThan(0);
  expect(lens.srt).toBeGreaterThan(0);
});

test('an edited caption is what the downloads carry, not a regenerated one', async ({ page }) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
  await page.fill('#captions-display .caption:first-child .line1', 'EDITED LINE');
  await expect.poll(async () => (await download(page, 'download-vtt')).includes('EDITED LINE')).toBe(true);
  expect(await download(page, 'download-srt')).toContain('EDITED LINE');
});

test('speaker colours reach a download taken before the captions are built (#536)', async ({ page }) => {
  await page.evaluate(() => window.HyperaudioSettings.set('captionColourSpeakers', true));
  expect(await page.evaluate(() => document.querySelectorAll('#captions-display .caption').length)).toBe(0);

  const vtt = await download(page, 'download-vtt');
  expect(vtt).toContain('STYLE');
  expect(vtt).toContain('<v Mark>');
  const srt = await download(page, 'download-srt');
  expect(srt).toMatch(/<font color="#[0-9a-f]{6}">/);
});

test('the word-level WebVTT is the same file from either view', async ({ page }) => {
  // It always read the transcript element straight out of the document, and in
  // caption mode the transcript is not there — so reaching the menu from the
  // caption editor downloaded a header with no cues under it.
  const fromTranscript = await download(page, 'download-vtt-words');
  expect(cueCount(fromTranscript)).toBeGreaterThan(3);

  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
  const fromCaptions = await download(page, 'download-vtt-words');
  expect(fromCaptions).toBe(fromTranscript);

  await page.click('#transcript-editor-btn');
  await expect.poll(() => page.locator('#hypertranscript').isVisible()).toBe(true);
  expect(await download(page, 'download-vtt-words')).toBe(fromTranscript);
});

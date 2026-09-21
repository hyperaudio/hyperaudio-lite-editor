// #666 — a quick exchange used to come out as two captions of a word or two
// each: a speaker label always started a new caption, and a short sentence
// could only ever join the caption BEFORE it. caption.js 2.3.0 (vendored from
// hyperaudio-lite) lets two speakers share a caption in the Netflix form — a
// speaker to a line, each line opening with a hyphen — and lets a short
// sentence lead the long one after it. The editor records a speaker for each
// LINE, colours the coloured downloads a line at a time, and drops the
// hyphens there, where the colour says who is speaking.
import { test, expect } from '@playwright/test';

// One word per 400ms; "|" starts a new paragraph, "@Name" a speaker label.
const transcriptHtml = (text, stepMs = 400) => {
  let t = 0;
  return '<article><section>' + text.split('|').map((para) =>
    '<p>' + para.trim().split(/\s+/).map((w) => {
      if (w.startsWith('@')) return `<span class="speaker" data-m="${t}" data-d="0">[${w.slice(1)}] </span>`;
      if (/^\+\d+$/.test(w)) { t += Number(w.slice(1)); return ''; }        // "+3000": a pause
      const span = `<span data-m="${t}" data-d="350">${w} </span>`;
      t += stepMs;
      return span;
    }).join('') + '</p>').join('') + '</section></article>';
};

const INTERVIEW = '@speaker-A to start? | @speaker-B Sure. So to start off, Dr. Ashby, can you just introduce yourself and give us a little insight into your background?';

const load = (page, text) => page.evaluate(async (html) => {
  document.getElementById('hypertranscript').innerHTML = html;
  document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  await new Promise((r) => setTimeout(r, 400));
}, transcriptHtml(text));

const cues = (page) => page.evaluate(() =>
  window.MediaExportCaptions.parseVttCues(window.HyperaudioSave.getCaptionsVtt()).map((c) => c.lines));

const openCaptions = async (page) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
};

const rows = (page) => page.evaluate(() => [...document.querySelectorAll('#captions-display .caption')].map((r) => ({
  line1: r.querySelector('.line1').value.trim(), line2: r.querySelector('.line2').value.trim(),
  speaker: r.getAttribute('data-speaker'), speaker2: r.getAttribute('data-speaker2'),
})));

const download = async (page, id) => {
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate((linkId) => document.getElementById(linkId).click(), id),
  ]);
  const chunks = [];
  for await (const c of await dl.createReadStream()) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForFunction(() => typeof window.MediaExportCaptions === 'object');
});

test('a quick exchange shares a caption: a speaker to a line, a hyphen on each (#666)', async ({ page }) => {
  await load(page, INTERVIEW);
  const generated = await cues(page);
  expect(generated[0]).toEqual(['-to start?', '-Sure.']);
  // the long sentence after it is one speaker's: no hyphen anywhere else
  generated.slice(1).flat().forEach((line) => expect(line.startsWith('-')).toBe(false));
  expect(generated.flat().join(' ')).toContain('Dr. Ashby');

  await openCaptions(page);
  const built = await rows(page);
  expect(built[0]).toEqual({ line1: '-to start?', line2: '-Sure.', speaker: 'speaker-A', speaker2: 'speaker-B' });
  expect(built.slice(1).every((r) => r.speaker === 'speaker-B' && r.speaker2 === null)).toBe(true);
  const recorded = await page.evaluate(() => window.captionSpeakerList());
  expect(recorded[0]).toEqual(['speaker-A', 'speaker-B']);
  expect(recorded.slice(1).every((entry) => entry === 'speaker-B')).toBe(true);
});

test('when the pause is too long to share, no hyphens, and the short sentence leads (#666)', async ({ page }) => {
  await load(page, INTERVIEW.replace('| @speaker-B', '| +3000 @speaker-B'));
  const generated = await cues(page);
  expect(generated[0]).toEqual(['to start?']);
  expect(generated[1][0].startsWith('Sure. So to start off,')).toBe(true);
  generated.flat().forEach((line) => expect(line.startsWith('-')).toBe(false));
  await openCaptions(page);
  expect((await rows(page)).every((r) => r.speaker2 === null)).toBe(true);
});

test('the paragraph setting turns sharing off (#666)', async ({ page }) => {
  await page.evaluate(() => window.HyperaudioSettings.set('captionParagraphBreaks', true));
  await load(page, INTERVIEW);
  const generated = await cues(page);
  expect(generated[0]).toEqual(['to start?']);
  generated.flat().forEach((line) => expect(line.startsWith('-')).toBe(false));
});

test('plain downloads keep the hyphens; coloured ones colour each line and drop them (#666)', async ({ page }) => {
  await load(page, INTERVIEW);
  await openCaptions(page);

  const plainVtt = await download(page, 'download-vtt');
  const plainSrt = await download(page, 'download-srt');
  expect(plainVtt).toMatch(/-to start\? ?\n-Sure\./);
  expect(plainSrt).toMatch(/-to start\? ?\n-Sure\./);

  await page.evaluate(() => window.HyperaudioSettings.set('captionColourSpeakers', true));
  const vtt = await download(page, 'download-vtt');
  expect(vtt).toContain('<v speaker-A>to start?</v>\n<v speaker-B>Sure.</v>');
  expect(vtt).not.toMatch(/<v [^>]+>-/);
  expect(vtt).toMatch(/::cue\(v\[voice="speaker-A"\]\)/);
  expect(vtt).toMatch(/::cue\(v\[voice="speaker-B"\]\)/);
  const srt = await download(page, 'download-srt');
  const fonts = [...srt.matchAll(/<font color="(#[0-9a-f]{6})">([^<]*)<\/font>/g)];
  expect(fonts.slice(0, 2).map((m) => m[2])).toEqual(['to start?', 'Sure.']);
  expect(fonts[0][1]).not.toBe(fonts[1][1]);

  // what the project holds is the plain form, hyphens and all
  expect(await page.evaluate(() => window.HyperaudioSave.getCaptionsVtt())).toMatch(/-to start\? ?\n-Sure\./);
});

test('a coloured download taken before the captions are built names both speakers (#666)', async ({ page }) => {
  await load(page, INTERVIEW);
  expect(await page.evaluate(() => document.querySelectorAll('#captions-display .caption').length)).toBe(0);
  await page.evaluate(() => window.HyperaudioSettings.set('captionColourSpeakers', true));
  const vtt = await download(page, 'download-vtt');
  expect(vtt).toContain('<v speaker-A>to start?</v>\n<v speaker-B>Sure.</v>');
});

test('both speakers travel with the project, and come back (#666)', async ({ page }) => {
  await load(page, INTERVIEW);
  await openCaptions(page);
  // a hand edit, so the saved captions are authoritative and cannot be regenerated
  await page.fill('#captions-display .caption:nth-child(2) .line1', 'Edited line');
  const before = await page.evaluate(() => window.captionSpeakerList());
  expect(before[0]).toEqual(['speaker-A', 'speaker-B']);

  const saved = await page.evaluate(async () => {
    const save = window.HyperaudioSave;
    await save.saveProject();
    const dir = await save.storage.projectDir(save.library.currentId());
    const state = JSON.parse(await save.storage.readText(dir, 'saved.json'));
    return JSON.parse(state.json).options.captions.speakers;
  });
  expect(saved).toEqual(before);

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await openCaptions(page);
  await expect.poll(() => page.evaluate(() => window.captionSpeakerList())).toEqual(before);
  expect((await rows(page))[0]).toEqual({ line1: '-to start?', line2: '-Sure.', speaker: 'speaker-A', speaker2: 'speaker-B' });
});

test('merging two one-line captions of different speakers makes a shared one (#666)', async ({ page }) => {
  // too far apart to be generated as one, so they arrive as two rows
  await load(page, '@Ann Ready? | +3000 @Bob Sure. | +3000 @Bob Fine.');
  await openCaptions(page);
  expect((await rows(page)).map((r) => r.line1)).toEqual(['Ready?', 'Sure.', 'Fine.']);

  await page.evaluate(() => document.querySelector('#captions-display .caption button[onclick^="mergeCaption"]').click());
  let after = await rows(page);
  expect(after[0]).toEqual({ line1: '-Ready?', line2: '-Sure.', speaker: 'Ann', speaker2: 'Bob' });
  expect(await page.evaluate(() => window.captionSpeakerList())).toEqual([['Ann', 'Bob'], 'Bob']);
  expect((await cues(page))[0]).toEqual(['-Ready?', '-Sure.']);

  // a caption inserted after it is in the second speaker's turn
  await page.evaluate(() => document.querySelector('#captions-display .caption button[onclick^="addCaption"]').click());
  after = await rows(page);
  expect(after[1].speaker).toBe('Bob');
});

test('merging two captions of one speaker is what it always was (#666)', async ({ page }) => {
  await load(page, '@Bob Sure. | +3000 @Bob Fine.');
  await openCaptions(page);
  await page.evaluate(() => document.querySelector('#captions-display .caption button[onclick^="mergeCaption"]').click());
  const after = await rows(page);
  expect(after).toHaveLength(1);
  expect(after[0].speaker2).toBe(null);
  expect((after[0].line1 + ' ' + after[0].line2).replace(/\s+/g, ' ').trim()).toBe('Sure. Fine.');
});

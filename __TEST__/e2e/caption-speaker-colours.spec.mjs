// #536 — the caption downloads said nothing about who was speaking. With the
// Settings toggle on, the .vtt and .srt downloads carry a colour per speaker.
// Export only: the speaker is recorded on each caption row when the captions
// are generated, so a later transcript edit cannot recolour captions the user
// has already finished, and the live track and the saved captions stay plain.
import { test, expect } from '@playwright/test';

const openCaptions = async (page) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
};

const recorded = (page) => page.evaluate(() => window.captionSpeakerList());

const rowSpeakers = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#captions-display .caption')].map((r) => r.getAttribute('data-speaker')));

// A second speaker, inserted before a word partway through the intro, then
// captions rebuilt from the transcript the way the app rebuilds them.
const addSecondSpeaker = async (page, index = 30, name = 'Ada') =>
  page.evaluate(([at, who]) => {
    const words = [...document.querySelectorAll('#hypertranscript span[data-m]')]
      .filter((s) => !s.classList.contains('speaker'));
    const target = words[at];
    const span = document.createElement('span');
    span.className = 'speaker';
    span.setAttribute('data-m', target.getAttribute('data-m'));
    span.setAttribute('data-d', '0');
    span.textContent = `[${who}] `;
    target.parentNode.insertBefore(span, target);
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
    return target.getAttribute('data-m');
  }, [index, name]);

const setColourSpeakers = (page, on) =>
  page.evaluate((v) => window.HyperaudioSettings.set('captionColourSpeakers', v), on);

// Click a download link and return what the browser was handed.
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

const linkText = (page, id) => page.evaluate((linkId) => {
  const href = document.getElementById(linkId).getAttribute('href') || '';
  return decodeURIComponent(href.slice(href.indexOf(',') + 1));
}, id);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('every generated caption records the speaker it came from (#536)', async ({ page }) => {
  await openCaptions(page);
  const speakers = await recorded(page);
  expect(speakers.length).toBeGreaterThan(3);
  // the intro is one speaker throughout, in square brackets
  expect(new Set(speakers)).toEqual(new Set(['Mark']));
  expect(await rowSpeakers(page)).toEqual(speakers);
});

test('a second speaker splits the record at the cue their turn starts (#536)', async ({ page }) => {
  const ms = await addSecondSpeaker(page);
  await openCaptions(page);
  const speakers = await recorded(page);
  const starts = await page.evaluate(() =>
    [...document.querySelectorAll('#captions-display .caption .start')].map((i) => i.value));

  expect(speakers).toContain('Mark');
  expect(speakers).toContain('Ada');
  // every Mark comes before every Ada, and the turn changes exactly at the
  // cue that starts on the label's own time
  const firstAda = speakers.indexOf('Ada');
  expect(speakers.slice(0, firstAda).every((s) => s === 'Mark')).toBe(true);
  expect(speakers.slice(firstAda).every((s) => s === 'Ada')).toBe(true);
  const seconds = (v) => {
    const m = /^(\d+):(\d\d):(\d\d)[.,](\d+)$/.exec(v.trim());
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number('0.' + m[4]);
  };
  expect(seconds(starts[firstAda])).toBeCloseTo(Number(ms) / 1000, 3);
});

test('insert inherits, merge keeps the survivor, delete leaves the rest (#536)', async ({ page }) => {
  await addSecondSpeaker(page);
  await openCaptions(page);
  const before = await recorded(page);
  const firstAda = before.indexOf('Ada');
  expect(firstAda).toBeGreaterThan(0);

  // insert after the last Mark: the new row belongs to that turn
  await page.evaluate((i) => {
    document.querySelectorAll('#captions-display .caption')[i]
      .querySelector('button[onclick^="addCaption"]').click();
  }, firstAda - 1);
  let after = await rowSpeakers(page);
  expect(after[firstAda]).toBe('Mark');
  expect(after[firstAda + 1]).toBe('Ada');

  // merge the last Mark with the row below it: the survivor keeps Mark
  await page.evaluate((i) => {
    document.querySelectorAll('#captions-display .caption')[i]
      .querySelector('button[onclick^="mergeCaption"]').click();
  }, firstAda);
  after = await rowSpeakers(page);
  expect(after[firstAda]).toBe('Mark');

  // delete it: the neighbours keep theirs
  await page.evaluate((i) => {
    document.querySelectorAll('#captions-display .caption')[i]
      .querySelector('button[onclick^="deleteCaption"]').click();
  }, firstAda);
  after = await rowSpeakers(page);
  expect(after[firstAda - 1]).toBe('Mark');
  expect(after[firstAda]).toBe('Ada');
});

test('with the setting off the downloads are exactly the plain files (#536)', async ({ page }) => {
  await openCaptions(page);
  const vtt = await download(page, 'download-vtt');
  const srt = await download(page, 'download-srt');
  expect(vtt).toBe(await linkText(page, 'download-vtt'));
  expect(srt).toBe(await linkText(page, 'download-srt'));
  expect(vtt).not.toContain('STYLE');
  expect(vtt).not.toContain('<v ');
  expect(srt).not.toContain('<font');
});

test('with the setting on the VTT carries a STYLE block and voice tags (#536)', async ({ page }) => {
  await addSecondSpeaker(page);
  await openCaptions(page);
  await setColourSpeakers(page, true);
  const vtt = await download(page, 'download-vtt');

  expect(vtt.startsWith('WEBVTT')).toBe(true);
  expect(vtt).toContain('STYLE');
  expect(vtt).toMatch(/::cue\(v\[voice="Mark"\]\) \{ color: #[0-9a-f]{6}; \}/);
  expect(vtt).toMatch(/::cue\(v\[voice="Ada"\]\) \{ color: #[0-9a-f]{6}; \}/);
  expect(vtt).toContain('<v Mark>');
  expect(vtt).toContain('<v Ada>');
  // the STYLE block sits before the first cue, where the spec wants it
  expect(vtt.indexOf('STYLE')).toBeLessThan(vtt.indexOf(' --> '));
  // two speakers, two different colours
  const colours = [...vtt.matchAll(/color: (#[0-9a-f]{6});/g)].map((m) => m[1]);
  expect(new Set(colours).size).toBe(2);
});

test('with the setting on the SRT carries a font colour per cue (#536)', async ({ page }) => {
  await addSecondSpeaker(page);
  await openCaptions(page);
  await setColourSpeakers(page, true);
  const srt = await download(page, 'download-srt');
  expect(srt).toMatch(/<font color="#[0-9a-f]{6}">/);
  expect(srt).toContain('</font>');
  // the numbering and timings are untouched
  expect(srt.startsWith('1\n')).toBe(true);
  expect(srt).toMatch(/\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d/);
});

test('the live track and the saved captions stay plain either way (#536)', async ({ page }) => {
  await addSecondSpeaker(page);
  await openCaptions(page);
  await setColourSpeakers(page, true);
  await download(page, 'download-vtt');

  const live = await page.evaluate(() => {
    const src = document.getElementById('hyperplayer-vtt').getAttribute('src') || '';
    const inline = src.startsWith('data:') ? decodeURIComponent(src.slice(src.indexOf(',') + 1)) : '';
    return { inline, saved: window.HyperaudioSave.getCaptionsVtt() };
  });
  [live.inline, live.saved].forEach((text) => {
    expect(text).not.toContain('STYLE');
    expect(text).not.toContain('<v ');
  });
  // and the menu link itself still holds the plain file
  expect(await linkText(page, 'download-vtt')).not.toContain('<v ');
});

test('the speakers travel with the project and come back (#536)', async ({ page }) => {
  await addSecondSpeaker(page);
  await openCaptions(page);
  // Hand-edit a caption, so the captions diverge from the transcript: from
  // here the saved file is authoritative and cannot be regenerated, which is
  // exactly when the saved list is the only thing carrying the speakers.
  await page.fill('#captions-display .caption:first-child .line1', 'Edited first line');
  const speakers = await recorded(page);
  expect(new Set(speakers)).toEqual(new Set(['Mark', 'Ada']));

  const saved = await page.evaluate(async () => {
    const save = window.HyperaudioSave;
    await save.saveProject();
    const dir = await save.storage.projectDir(save.library.currentId());
    const state = JSON.parse(await save.storage.readText(dir, 'saved.json'));
    return { container: JSON.parse(state.json), captionsVtt: state.captionsVtt };
  });
  expect(saved.container.options.captions.speakers).toEqual(speakers);
  // beside the captions file, never inside it: what is saved stays plain
  expect(saved.captionsVtt).not.toContain('<v ');
  expect(saved.captionsVtt).not.toContain('STYLE');

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await openCaptions(page);
  await expect.poll(() => recorded(page)).toEqual(speakers);
  expect(await page.inputValue('#captions-display .caption:first-child .line1')).toBe('Edited first line');
});

test('a saved list that does not match the cues is dropped, not misapplied (#536)', async ({ page }) => {
  await addSecondSpeaker(page);
  await openCaptions(page);
  await page.fill('#captions-display .caption:first-child .line1', 'Edited first line');
  await expect.poll(() => recorded(page)).not.toEqual([]);

  // save, then shorten the stored list behind the app's back: the cue count
  // and the list no longer agree, which is the case the guard exists for
  await page.evaluate(async () => {
    const save = window.HyperaudioSave;
    await save.saveProject();
    const dir = await save.storage.projectDir(save.library.currentId());
    const state = JSON.parse(await save.storage.readText(dir, 'saved.json'));
    const container = JSON.parse(state.json);
    container.options.captions.speakers = container.options.captions.speakers.slice(0, 2);
    state.json = JSON.stringify(container);
    await save.storage.writeFile(dir, 'saved.json', JSON.stringify(state));
  });

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await openCaptions(page);
  // no caption is coloured, rather than the first two being coloured wrongly
  const after = await rowSpeakers(page);
  expect(after.length).toBeGreaterThan(2);
  expect(after.every((s) => s === null)).toBe(true);
});

test('a transcript with no speakers downloads unchanged (#536)', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelectorAll('#hypertranscript span.speaker').forEach((s) => s.remove());
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  });
  await openCaptions(page);
  await setColourSpeakers(page, true);
  expect(await recorded(page)).toEqual(new Array((await recorded(page)).length).fill(''));
  const vtt = await download(page, 'download-vtt');
  expect(vtt).toBe(await linkText(page, 'download-vtt'));
  expect(vtt).not.toContain('STYLE');
});

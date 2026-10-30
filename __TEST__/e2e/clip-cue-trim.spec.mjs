// #748 — a clip burned, and its sidecar captions carried, every word of a cue
// the selection started or ended inside, and the read-along highlight ran
// over the unselected words to the clip's end. A clip's cues are now cut to
// its selected words, and timed to the selection where they were cut.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { ladderWav } from './helpers.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

// 30 one-second words in three-word cues: "w9 w10 w11" at 9–12 s … so a
// selection of w10–w19 starts and ends inside a cue
const WORDS = Array.from({ length: 30 }, (_, i) => `<span data-m="${i * 1000}" data-d="1000">w${i} </span>`).join('');

test('a clip\'s captions carry its selected words only, and end with them', async ({ page }) => {
  const wav = ladderWav(30, 8000);
  await page.route('**/__clip.wav', (route) => route.fulfill({ body: wav, contentType: 'audio/wav' }));
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function');
  await page.evaluate(async () => {
    const blob = await (await fetch('/__clip.wav')).blob();
    document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 1 && p.duration > 29;
  });
  await page.evaluate((html) => {
    document.getElementById('hypertranscript').innerHTML = `<article><section><p>${html}</p></section></article>`;
    const t = (s) => `00:00:${String(s).padStart(2, '0')}.000`;
    const cues = Array.from({ length: 10 }, (_, k) => `${t(3 * k)} --> ${t(3 * k + 3)}\nw${3 * k} w${3 * k + 1} w${3 * k + 2}\n`);
    document.getElementById('hyperplayer-vtt').src = 'data:text/vtt,' + encodeURIComponent('WEBVTT\n\n' + cues.join('\n'));
  }, WORDS);
  await page.evaluate(() => {
    const spans = document.querySelectorAll('#hypertranscript [data-m]');
    const range = document.createRange();
    range.setStart(spans[10].firstChild, 0);
    range.setEnd(spans[19].firstChild, spans[19].textContent.trimEnd().length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));   // selectionchange is async
  await page.evaluate(() => {
    document.activeElement && document.activeElement.blur();
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
  await page.selectOption('#export-format', 'wav');
  await page.evaluate(() => {
    const set = (id, on) => {
      const c = document.getElementById(id);
      if (c) { c.checked = on; c.dispatchEvent(new Event('change')); }
    };
    ['export-vtt', 'export-burn', 'export-project', 'export-adjust'].forEach((id) => set(id, false));
    set('export-retime', true);
    set('export-srt', true);
    set('export-zip', true);
    document.getElementById('export-name').value = 'clip';
  });
  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-start');
  const download = await downloadPromise;
  await page.waitForFunction(() => document.getElementById('export-status').textContent.startsWith('Done'));

  const fs = await import('node:fs/promises');
  const zip = await JSZip.loadAsync(await fs.readFile(await download.path()));
  const srt = await zip.file('clip/clip.srt').async('string');
  const spoken = [...srt.matchAll(/\bw(\d+)\b/g)].map((m) => Number(m[1]));
  expect(spoken).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const times = [...srt.matchAll(/(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/g)].map((m) => [m[1], m[2]]);
  // the first cue starts with w10, 0.1 s into the clip, and the last ends
  // with w19, at 10.1 s, not 0.1 s later in the padding
  expect(times[0]).toEqual(['00:00:00,100', '00:00:02,100']);
  expect(times[times.length - 1]).toEqual(['00:00:08,100', '00:00:10,100']);
});

// The cutting itself, on the caption pipeline's own seam
test('words outside the selection go, line by line, and the cue is timed to the selection where it was cut', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const r = await page.evaluate(() => {
    const c = window.MediaExportCaptions;
    const words = [11.76, 12.3, 12.7, 13.4, 13.9, 15.04, 15.28, 15.9].map((start, i) => ({ start, text: 'w' + i }));
    // the issue's cue: a dual-speaker caption whose second line is the next
    // speaker's first word, with the selection ending at "Mozfest."
    const dual = { start: 11.76, end: 15.28, lines: ['-And we\'re sitting at Mozfest.', '-This'] };
    const next = { start: 15.28, end: 16.88, lines: ['is Marusa.'] };
    return {
      // the selection ends at Mozfest.: the second speaker's word goes, and
      // the one line left is a plain caption ending with its last word
      end: c.clipCues([dual], words, { from: 11.76, to: 15.04 }),
      // starting inside the first line, with both speakers selected: the
      // line keeps its '-', and the cue starts with the selection
      start: c.clipCues([dual, next], words, { from: 12.7, to: 16.3 }),
      // a cue the selection covers whole keeps its own times and text
      whole: c.clipCues([dual], words, { from: 11.76, to: 15.9 }),
      // an edited cue, whose words do not line up with the transcript's, stays whole
      edited: c.clipCues([{ start: 11.76, end: 15.28, lines: ['And we are sitting at Mozfest, you know.'] }], words, { from: 11.76, to: 15.04 }),
      // a cue left with no selected word goes
      none: c.clipCues([{ start: 11.0, end: 11.9, lines: ['w0'] }], words, { from: 12.3, to: 15.04 }),
    };
  });
  expect(r.end).toEqual([{ start: 11.76, end: 15.04, lines: ['And we\'re sitting at Mozfest.'] }]);
  expect(r.start).toEqual([
    { start: 12.7, end: 15.28, lines: ['-sitting at Mozfest.', '-This'] },
    { start: 15.28, end: 16.88, lines: ['is Marusa.'] },
  ]);
  expect(r.whole).toEqual([{ start: 11.76, end: 15.28, lines: ['-And we\'re sitting at Mozfest.', '-This'] }]);
  expect(r.edited).toEqual([{ start: 11.76, end: 15.28, lines: ['And we are sitting at Mozfest, you know.'] }]);
  expect(r.none).toEqual([]);
});

test('the read-along highlight of a cut cue comes from the words, not spread over the clip', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const chunks = await page.evaluate(() => {
    const c = window.MediaExportCaptions;
    const words = [18, 19, 20].map((start, i) => ({ start, text: 'w' + (18 + i) }));
    const cut = c.clipCues([{ start: 18, end: 21, lines: ['w18 w19 w20'] }], words, { from: 10, to: 20 });
    const sections = [{ start: 9.9, end: 20.1 }];
    const retimed = c.retimeCues(cut, sections, 1);
    // the clip's own words, retimed as its transcript is
    return c.cuesToChunks(retimed, [{ text: 'w18', start: 8.1 }, { text: 'w19', start: 9.1 }]);
  });
  expect(chunks).toEqual([{ start: 8.1, end: 10.1, lines: [[{ text: 'w18', start: 8.1 }, { text: 'w19', start: 9.1 }]] }]);
});

// #656 — a media export read the LIVE editor at every step: the cuts and the
// name before the render, then the transcript, the cues, the title and the
// project metadata after it. An edit made while the encoder ran, or another
// project opened from Recents meanwhile, put that text, those captions and
// that metadata beside the first project's media — one archive, two projects.
// A run now captures everything it needs when it starts and derives every
// output from that; the media is resolved against the captured project too.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { ladderWav, analyseWav, withoutIntroProject } from './helpers.mjs';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js');
const JSZip = require('jszip');

const wordsHtml = (words) => '<article><section><p>' + words.map((w, i) =>
  `<span data-m="${i * 1000}" data-d="1000">${w} </span>`).join('') + '</p></section></article>';

// A project born from a local file through the transcribe picker, the way a
// user makes one: its media is stored in the library, which is where the
// exporter resolves it. One word per second, so the ladder's tones and the
// words agree about time.
const makeProject = async (page, name, words) => {
  await page.route(`**/__${name}`, (route) => route.fulfill({ body: ladderWav(words.length), contentType: 'audio/wav' }));
  await page.evaluate(async ([name, html]) => {
    const blob = await (await fetch('/__' + name)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], name, { type: 'audio/wav' }));
    const input = document.querySelector('#deepgram-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('#hypertranscript').innerHTML = '<div>Transcribing….</div>';
    window.setTranscriptBusy(true);
    await new Promise((r) => setTimeout(r, 800));
    document.querySelector('#hypertranscript').innerHTML = html;
    window.setTranscriptBusy(false);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  }, [name, wordsHtml(words)]);
  await expect.poll(() => page.evaluate(async () => ((await window.HyperaudioSave.library.list())[0] || {}).name)).toBe(name);
  const id = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  // its media is in the library, and its captions on the track
  await expect.poll(() => page.evaluate(async (id) => {
    const f = await window.HyperaudioSave.mediaFileFor(id);
    return f !== null && f.size > 1000;
  }, id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.getCaptionsVtt())).toContain(words[0]);
  await page.waitForFunction(() => document.getElementById('hyperplayer').readyState >= 1);
  return id;
};

const openProject = async (page, id, firstWord) => {
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), id);
  await expect(page.locator('#hypertranscript')).toContainText(firstWord);
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.getCaptionsVtt())).toContain(firstWord);
  await page.waitForFunction(() => document.getElementById('hyperplayer').readyState >= 1);
};

// Open the export modal for a WAV with the given extras, delivered separately.
const setUpExport = async (page, name, extras) => {
  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true; m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
  await page.selectOption('#export-format', 'wav');
  await page.evaluate(([name, extras]) => {
    for (const id of ['export-retime', 'export-vtt', 'export-srt', 'export-project', 'export-burn', 'export-zip']) {
      const c = document.getElementById(id);
      if (c) { c.checked = extras.includes(id); c.dispatchEvent(new Event('change')); }
    }
    document.getElementById('export-name').value = name;
  }, [name, extras]);
};

// Hold the run at its first read of stored media (the library file), so the
// editor can be changed while it is under way, then let it go.
const holdMediaRead = (page) => page.evaluate(() => {
  const original = FileSystemFileHandle.prototype.getFile;
  window.__release = null;
  FileSystemFileHandle.prototype.getFile = async function (...args) {
    if (window.__release === null && /\.wav$/.test(this.name)) {
      await new Promise((release) => { window.__release = release; });
    }
    return original.apply(this, args);
  };
});
const awaitHeld = (page) => page.waitForFunction(() => window.__release !== null);
const release = (page) => page.evaluate(() => window.__release());

const runAndCollect = async (page, expectedFiles) => {
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.click('#export-start');
  return {
    downloads,
    finished: async () => {
      await page.waitForFunction(() => document.getElementById('export-status').textContent.startsWith('Done'), null, { timeout: 90000 });
      await expect.poll(() => downloads.length).toBe(expectedFiles);
      const fs = await import('node:fs/promises');
      const files = {};
      for (const d of downloads) files[d.suggestedFilename()] = await fs.readFile(await d.path());
      return files;
    },
  };
};

const projectFiles = (page, id) => page.evaluate(async (id) => {
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(id);
  const out = {};
  for (const name of ['draft.json', 'saved.json']) {
    try { out[name] = await (await (await dir.getFileHandle(name)).getFile()).text(); } catch (e) { out[name] = null; }
  }
  const lib = JSON.parse(await (await (await root.getFileHandle('library.json')).getFile()).text());
  out.entry = lib.projects.find((p) => p.id === id);
  return out;
}, id);

const A = ['alpha', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const B = ['bravo', 'uno', 'due', 'tre'];

test.beforeEach(async ({ page }) => {
  await withoutIntroProject(page);
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function');
});

test('opening another project during a run changes none of its outputs, and writes nothing into that project (#656)', async ({ page }) => {
  const aId = await makeProject(page, 'ladder-a.wav', A);
  const bId = await makeProject(page, 'ladder-b.wav', B);
  await openProject(page, aId, 'alpha');

  await setUpExport(page, 'ctx-a', ['export-retime', 'export-vtt', 'export-srt', 'export-project']);
  await holdMediaRead(page);
  const run = await runAndCollect(page, 5);
  await awaitHeld(page);

  // the run is under way; the user goes to B from Recents
  await openProject(page, bId, 'bravo');
  const bBefore = await projectFiles(page, bId);
  await release(page);
  const files = await run.finished();

  expect(Object.keys(files).sort()).toEqual(['ctx-a-transcript.html', 'ctx-a.hyperaudio', 'ctx-a.srt', 'ctx-a.vtt', 'ctx-a.wav']);
  // A's media: ten seconds of A's ladder, not B's four
  const audio = analyseWav(files['ctx-a.wav']);
  expect(Math.abs(audio.duration - 10)).toBeLessThan(0.05);
  expect(audio.freqs.slice(0, 4)).toEqual([200, 200, 300, 300]);
  // A's words, A's cues, A's title — B's nowhere
  for (const name of ['ctx-a-transcript.html', 'ctx-a.vtt', 'ctx-a.srt']) {
    const text = files[name].toString('utf8');
    expect(text, name).toContain('alpha');
    expect(text, name).not.toContain('bravo');
  }
  expect(files['ctx-a-transcript.html'].toString('utf8')).toContain('ladder-a.wav');
  expect(files['ctx-a-transcript.html'].toString('utf8')).not.toContain('ladder-b');
  const res = await save.unzipProject(new Uint8Array(files['ctx-a.hyperaudio']), JSZip);
  expect(res.recovered).toBeFalsy();
  expect(res.project.transcript.words.map((w) => w.text)).toEqual(A);
  expect(Math.abs(res.project.media.durationSeconds - 10)).toBeLessThan(0.05);
  expect(res.captionsVtt).toContain('alpha');
  expect(res.captionsVtt).not.toContain('bravo');

  // B is as it was: on screen, and on disk
  await expect(page.locator('#hypertranscript')).toContainText('bravo');
  expect(await projectFiles(page, bId)).toEqual(bBefore);
});

test('edits made during a run reach the editor, not the outputs (#656)', async ({ page }) => {
  await makeProject(page, 'ladder-a.wav', A);
  // strike "three": the cut the run is asked for
  await page.evaluate(() => {
    document.querySelectorAll('#hypertranscript span[data-m]')[3].style.textDecoration = 'line-through';
  });
  await setUpExport(page, 'ctx-e', ['export-retime', 'export-vtt', 'export-srt']);
  expect(await page.isChecked('#export-source-edited')).toBe(true);

  await holdMediaRead(page);
  const run = await runAndCollect(page, 4);
  await awaitHeld(page);
  // under way: change a word, move the strike, and replace the caption track
  await page.evaluate(() => {
    const spans = document.querySelectorAll('#hypertranscript span[data-m]');
    spans[0].textContent = 'CHANGED ';
    spans[3].style.textDecoration = '';
    spans[7].style.textDecoration = 'line-through';
    document.getElementById('hyperplayer-vtt').src = 'data:text/vtt,' + encodeURIComponent('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nLATE CUE\n');
  });
  await release(page);
  const files = await run.finished();

  // the media has the cut that was asked for — second 3 (500 Hz) gone, second
  // 7 (900 Hz) still there — and nine seconds in all
  const audio = analyseWav(files['ctx-e.wav']);
  expect(Math.abs(audio.duration - 9)).toBeLessThan(0.05);
  expect(audio.freqs).not.toContain(500);
  expect(audio.freqs).toContain(900);
  // the transcript as it was: "alpha", "three" cut, "seven" kept
  const html = files['ctx-e-transcript.html'].toString('utf8');
  expect(html).toContain('alpha');
  expect(html).not.toContain('CHANGED');
  expect(html).not.toContain('>three ');
  expect(html).toContain('>seven ');
  // the cues as they were
  for (const name of ['ctx-e.vtt', 'ctx-e.srt']) {
    expect(files[name].toString('utf8'), name).toContain('alpha');
    expect(files[name].toString('utf8'), name).not.toContain('LATE CUE');
  }
  // and the editor kept every edit
  await expect(page.locator('#hypertranscript')).toContainText('CHANGED');
  expect(await page.evaluate(() => window.HyperaudioSave.getCaptionsVtt())).toContain('LATE CUE');
  expect(await page.evaluate(() =>
    document.querySelectorAll('#hypertranscript span[data-m]')[7].style.textDecoration)).toBe('line-through');
});

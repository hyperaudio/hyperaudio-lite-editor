// Flattened project export (#455): the "new project (.hyperaudio)" option must
// produce a conforming container whose media IS the edited render (struck
// seconds genuinely absent) and whose transcript is re-timed with struck words
// removed. Uses the tone-ladder so the media's content encodes provenance.
// Requires network: the export modal lazy-loads mediabunny from its CDN.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { ladderWav, analyseWav, transcriptHtml } from './helpers.mjs';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js'); // pure layer only under node
const JSZip = require('jszip');

test('flattened .hyperaudio export: edited media, re-timed struck-free transcript', async ({ page }) => {
  const wav = ladderWav(10); // tones: sec N = (200 + N*100) Hz
  await page.route('**/__ladder.wav', (route) => route.fulfill({
    body: wav, contentType: 'audio/wav',
  }));
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function');

  await page.evaluate(async () => {
    const blob = await (await fetch('/__ladder.wav')).blob();
    document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 1 && p.duration > 9;
  });

  // one word per second; strike seconds 3 and 7
  const words = Array.from({ length: 10 }, (_, i) => [i * 1000, 1000, i === 3 || i === 7 ? 1 : 0]);
  await page.evaluate((html) => {
    document.getElementById('hypertranscript').innerHTML = html;
  }, transcriptHtml(words));

  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
  await page.selectOption('#export-format', 'wav');
  await page.evaluate(() => {
    // only the media file + the project container, delivered separately —
    // export-zip is on by default for multi-file runs (#396) and this test is
    // about the container itself, not the packaging
    for (const id of ['export-retime', 'export-vtt', 'export-srt', 'export-burn', 'export-zip']) {
      const c = document.getElementById(id);
      if (c) c.checked = false;
    }
    const p = document.getElementById('export-project');
    p.checked = true;
    document.getElementById('export-name').value = 'flattened';
  });

  const first = page.waitForEvent('download');
  await page.click('#export-start');
  const wavDownload = await first;
  const second = await page.waitForEvent('download');
  await page.waitForFunction(() => document.getElementById('export-status').textContent.startsWith('Done'));

  expect(wavDownload.suggestedFilename()).toBe('flattened.wav');
  expect(second.suggestedFilename()).toBe('flattened.hyperaudio');

  const fs = await import('node:fs/promises');
  const bytes = await fs.readFile(await second.path());

  // read through the app's own reader: enforces the entry whitelist and STORE
  // on the media entry, and validates the project JSON shape
  const res = await save.unzipProject(new Uint8Array(bytes), JSZip);
  expect(res.recovered).toBeFalsy();
  const project = res.project;

  // container identity: fresh original-media project, format ≥ 1.3
  expect(project.media.kind).toBe('original');
  expect(project.media.path).toBe('media/flattened.wav');
  expect(project.media.filename).toBe('flattened.wav');
  expect(Math.abs(project.media.durationSeconds - 8)).toBeLessThan(0.05);
  expect(project.media.sizeBytes).toBe(res.mediaData.byteLength ?? res.mediaData.length);
  expect(project.texts.title).toBe('flattened');
  // cuts are baked into the media — replaying gap removal would cut twice
  expect(project.options.gapRemoval.enabled).toBe(false);
  // the origin transcript does not match the rendered timeline
  expect(project.provenance?.originalTranscript).toBeUndefined();

  // transcript: 8 words, none struck, re-timed onto the edited timeline —
  // the word originally at 4s starts at 3s once struck second 3 is cut
  expect(project.transcript.words.length).toBe(8);
  expect(project.transcript.words.some((w) => w.struck === true)).toBe(false);
  const starts = project.transcript.words.map((w) => Math.round(w.start));
  expect(starts).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

  // the media itself: 8 seconds, struck tones (500Hz, 900Hz) absent
  const { duration, freqs } = analyseWav(Buffer.from(res.mediaData));
  expect(Math.abs(duration - 8)).toBeLessThan(0.01);
  expect(freqs).not.toContain(500);
  expect(freqs).not.toContain(900);
});

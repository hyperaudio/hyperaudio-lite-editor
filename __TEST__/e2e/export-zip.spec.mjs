// #396 — a multi-file export arrives as ONE .zip containing ONE folder.
//
// The reason is not tidiness. The interactive transcript links its media by bare
// filename, and handing the browser several downloads lets its de-duplication
// rename one of them: "clip.mp4" lands as "clip (1).mp4" when Downloads already
// holds that name, and the transcript then silently plays whatever the older
// file was — wrong media that plays, rather than a dead player. Archive entries
// cannot be renamed that way, and a colliding FOLDER is suffixed while its
// contents keep their names and their pairing.
//
// Requires network: the export modal lazy-loads mediabunny.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { ladderWav, transcriptHtml } from './helpers.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

// Load a short tone ladder and a matching transcript, then open the export modal.
async function openExportModal(page) {
  const wav = ladderWav(3);
  await page.route('**/__zip.wav', (route) => route.fulfill({ body: wav, contentType: 'audio/wav' }));
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function');

  await page.evaluate(async () => {
    const blob = await (await fetch('/__zip.wav')).blob();
    document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 1 && p.duration > 2;
  });
  await page.evaluate((html) => {
    document.getElementById('hypertranscript').innerHTML = html;
  }, transcriptHtml([[0, 1000], [1000, 1000], [2000, 1000]]));

  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(
    () => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
  await page.selectOption('#export-format', 'wav');
}

test('a multi-file export downloads once, as a zip holding one folder', async ({ page }) => {
  await openExportModal(page);

  // media + SRT = two outputs, so the zip applies
  await page.evaluate(() => {
    const set = (id, on) => {
      const c = document.getElementById(id);
      if (c) { c.checked = on; c.dispatchEvent(new Event('change')); }
    };
    ['export-retime', 'export-vtt', 'export-burn', 'export-project'].forEach((id) => set(id, false));
    set('export-srt', true);
    set('export-zip', true);
    document.getElementById('export-name').value = 'my clip';
  });

  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-start');
  const download = await downloadPromise;
  await page.waitForFunction(
    () => document.getElementById('export-status').textContent.startsWith('Done'));

  // Since #560 the names we WRITE carry no spaces: the interactive transcript
  // links its media by bare filename, and a space there means the page says
  // "my%20clip.wav" while the disk says "my clip.wav" — a pair static hosts
  // and equality checks handle inconsistently. The typed name is the user's;
  // the written ones are ours to make safe.
  expect(download.suggestedFilename()).toBe('my_clip.zip');

  const fs = await import('node:fs/promises');
  const zip = await JSZip.loadAsync(await fs.readFile(await download.path()));
  const paths = Object.keys(zip.files);

  // every entry sits under exactly one top-level folder
  const tops = new Set(paths.map((p) => p.split('/')[0]));
  expect([...tops]).toEqual(['my_clip']);

  // and that folder holds both files, under their own names
  const names = paths.filter((p) => !zip.files[p].dir).map((p) => p.split('/').pop()).sort();
  expect(names).toEqual(['my_clip.srt', 'my_clip.wav']);

  // the media survives the round trip as real bytes
  const wavEntry = zip.file('my_clip/my_clip.wav');
  expect(wavEntry).not.toBeNull();
  const bytes = await wavEntry.async('uint8array');
  expect(bytes.length).toBeGreaterThan(1000);
  expect(Buffer.from(bytes.slice(0, 4)).toString('ascii')).toBe('RIFF');
});

test('a single-file export is not zipped, and the offer is hidden', async ({ page }) => {
  await openExportModal(page);

  await page.evaluate(() => {
    const set = (id, on) => {
      const c = document.getElementById(id);
      if (c) { c.checked = on; c.dispatchEvent(new Event('change')); }
    };
    ['export-retime', 'export-vtt', 'export-srt', 'export-burn', 'export-project']
      .forEach((id) => set(id, false));
    document.getElementById('export-name').value = 'solo';
  });

  // nothing to bundle, so the toggle is not offered
  await expect(page.locator('#export-zip-row')).toBeHidden();

  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-start');
  const download = await downloadPromise;
  await page.waitForFunction(
    () => document.getElementById('export-status').textContent.startsWith('Done'));

  expect(download.suggestedFilename()).toBe('solo.wav');
});

test('the zip offer appears once a second file is selected', async ({ page }) => {
  await openExportModal(page);
  await page.evaluate(() => {
    ['export-retime', 'export-vtt', 'export-srt', 'export-burn', 'export-project'].forEach((id) => {
      const c = document.getElementById(id);
      if (c) { c.checked = false; c.dispatchEvent(new Event('change')); }
    });
  });
  await expect(page.locator('#export-zip-row')).toBeHidden();

  // the "keep them together" warning is what the zip replaces
  await page.evaluate(() => {
    const c = document.getElementById('export-srt');
    c.checked = true;
    c.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#export-zip-row')).toBeVisible();
  await expect(page.locator('#export-name-note')).toContainText('one .zip');

  // turning the zip off brings the warning back
  await page.evaluate(() => {
    const c = document.getElementById('export-zip');
    c.checked = false;
    c.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#export-name-note')).toContainText('keep the downloads together');
});

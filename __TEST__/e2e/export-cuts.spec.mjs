// Edited media export must contain exactly the kept timeline. Uses a "tone
// ladder" (a distinct tone per second) so the exported audio's content encodes
// which parts of the original timeline it came from. Requires network: the
// export modal lazy-loads mediabunny from its CDN.
import { test, expect } from '@playwright/test';
import { ladderWav, analyseWav, transcriptHtml } from './helpers.mjs';

test('edited WAV export drops struck seconds sample-accurately', async ({ page }) => {
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
    const c = document.getElementById('export-retime');
    if (c) c.checked = false;
  });

  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-start');
  const download = await downloadPromise;
  await page.waitForFunction(() => document.getElementById('export-status').textContent.startsWith('Done'));

  const path = await download.path();
  const { duration, freqs } = analyseWav(await (await import('node:fs/promises')).readFile(path));

  // 10s minus the two struck seconds
  expect(Math.abs(duration - 8)).toBeLessThan(0.01);
  // content order: 0,1,2, 4,5,6, 8,9 → tones 200,300,400,600,700,800,1000,1100
  // (first half-window can carry a boundary transient; assert from window 1)
  const expected = [200, 200, 300, 300, 400, 400, 600, 600, 700, 700, 800, 800, 1000, 1000, 1100, 1100];
  expect(freqs.slice(1)).toEqual(expected.slice(1));
  // the struck tones (500Hz, 900Hz) must not appear anywhere
  expect(freqs).not.toContain(500);
  expect(freqs).not.toContain(900);
});

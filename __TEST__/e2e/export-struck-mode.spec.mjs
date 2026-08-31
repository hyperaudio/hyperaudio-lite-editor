// #605 — the exported text must match the media it ships with.
//
//   Entire media  → the original AV file, untouched. Every struck word is
//                   still audible, so the transcript and captions keep them.
//   Edited media  → cuts applied, media re-rendered, struck words genuinely
//                   gone from the audio, so the text drops them and re-times.
//
// The removal used to ignore that choice entirely: it ran before `sections`
// was ever consulted, so Entire media shipped an untouched file beside a
// transcript missing words you can plainly hear.
//
// Requires network: the export modal lazy-loads mediabunny from its CDN.
import { test, expect } from '@playwright/test';
import { ladderWav, transcriptHtml } from './helpers.mjs';

const STRUCK_INDEX = 3;

async function exportWith({ page, edited }) {
  const wav = ladderWav(10);
  await page.route('**/__ladder.wav', (route) => route.fulfill({ body: wav, contentType: 'audio/wav' }));
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

  // one word per second, one of them struck
  const words = Array.from({ length: 10 }, (_, i) => [i * 1000, 1000, i === STRUCK_INDEX ? 1 : 0]);
  await page.evaluate(([html, idx]) => {
    document.getElementById('hypertranscript').innerHTML = html;
    // a recognisable token in the struck word, so its presence is provable
    const spans = document.querySelectorAll('#hypertranscript span[data-m]');
    spans[idx].textContent = 'STRUCKTOKEN ';
  }, [transcriptHtml(words), STRUCK_INDEX]);

  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
  await page.selectOption('#export-format', 'wav');
  await page.evaluate((wantEdited) => {
    const src = document.getElementById(wantEdited ? 'export-source-edited' : 'export-source-entire');
    src.checked = true;
    src.dispatchEvent(new Event('change', { bubbles: true }));
    const retime = document.getElementById('export-retime');
    if (retime) { retime.checked = true; retime.dispatchEvent(new Event('change', { bubbles: true })); }
    const zip = document.getElementById('export-zip');
    if (zip) { zip.checked = false; zip.dispatchEvent(new Event('change', { bubbles: true })); }
  }, edited);

  const files = [];
  page.on('download', async (d) => {
    const chunks = [];
    for await (const c of await d.createReadStream()) chunks.push(c);
    files.push({ name: d.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') });
  });
  await page.click('#export-start');
  await page.waitForFunction(
    () => document.getElementById('export-status').textContent.startsWith('Done'),
    null, { timeout: 120000 },
  );
  await page.waitForTimeout(1500); // let the downloads drain
  return files.find((f) => /\.html$/i.test(f.name));
}

test('Entire media keeps struck words: the text matches the untouched file (#605)', async ({ page }) => {
  const html = await exportWith({ page, edited: false });
  expect(html, 'an interactive transcript should have been exported').toBeTruthy();
  expect(html.text).toContain('STRUCKTOKEN');
});

test('Edited media drops struck words: the audio no longer has them (#605)', async ({ page }) => {
  const html = await exportWith({ page, edited: true });
  expect(html, 'an interactive transcript should have been exported').toBeTruthy();
  expect(html.text).not.toContain('STRUCKTOKEN');
});

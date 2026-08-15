import { test, expect } from '@playwright/test';
import JSZip from 'jszip';

// #581 — the FILE → Interactive Transcript modal must never inline captions.
// It passed the live track's src straight into the page, and that src is a
// data:text/vtt URL: a percent-encoded copy of the whole caption track inside
// the HTML, and a shape no <track srclang> per language can extend to.
// The page and its .vtt now travel together in one archive, because two
// downloads would let the browser rename the second and silently break the
// page's reference to it.

const runModalExport = async (page) => {
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => {
    document.getElementById('interactive-export-modal').checked = true;
    document.getElementById('interactive-media-filename').value = 'clip.mp4';
    document.getElementById('interactive-export-download').click();
  });
  const download = await downloadPromise;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return { name: download.suggestedFilename(), bytes: Buffer.concat(chunks) };
};

test('captions leave as a file, and the page links them by name (#581)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // the demo boots with captions on the live track
  await page.waitForFunction(() => {
    const t = document.getElementById('hyperplayer-vtt');
    return t !== null && (t.src || '').startsWith('data:');
  });

  const out = await runModalExport(page);
  expect(out.name).toMatch(/\.zip$/);

  const zip = await JSZip.loadAsync(out.bytes);
  const names = Object.keys(zip.files).filter((p) => !zip.files[p].dir).map((p) => p.split('/').pop());
  const html = await zip.file(Object.keys(zip.files).find((p) => p.endsWith('.html'))).async('string');
  const vttName = names.find((n) => n.endsWith('.vtt'));

  expect(vttName).toBeTruthy();
  expect(html).not.toContain('data:text/vtt');       // never inlined
  expect(html).toContain(`src="${vttName}"`);        // linked by plain filename
  const vtt = await zip.file(Object.keys(zip.files).find((p) => p.endsWith('.vtt'))).async('string');
  expect(vtt).toContain('WEBVTT');                   // and it is a real track
});

test('with no captions it stays a single HTML file, with no empty track (#581)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(() => {
    const t = document.getElementById('hyperplayer-vtt');
    if (t) t.removeAttribute('src');
  });

  const out = await runModalExport(page);
  expect(out.name).toMatch(/\.html$/);
  const html = out.bytes.toString('utf8');
  expect(html).not.toContain('<track');
  expect(html).not.toContain('data:text/vtt');
});

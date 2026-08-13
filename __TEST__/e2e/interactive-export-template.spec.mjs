import { test, expect } from '@playwright/test';

// The exported interactive transcript is an archival artefact: it gets
// published, linked and cited long after it leaves the editor. What it loads
// at that point is a promise we make to the reader — so the template's
// third-party dependencies are asserted here rather than trusted.
//
// #562: Velocity was loaded from cdnjs and never called. hyperaudio-lite has
// scrolled natively since 2.x (scrollToParagraph → smoothScrollTo, a
// requestAnimationFrame loop with easeInOutCubic), so the tag was pure
// legacy — a third-party request on every exported page, for nothing.

const exportedHtml = async (page) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => {
    document.getElementById('interactive-export-modal').checked = true;
    document.getElementById('interactive-media-filename').value = 'clip.mp4';
    document.getElementById('interactive-export-download').click();
  });
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

test('the exported page loads no Velocity, and no cdnjs at all (#562)', async ({ page }) => {
  const html = await exportedHtml(page);
  expect(html).not.toContain('velocity');
  expect(html).not.toContain('cdnjs.cloudflare.com');
});

test('the exported page still carries the player that does the scrolling (#562)', async ({ page }) => {
  const html = await exportedHtml(page);
  expect(html).toContain('hyperaudio-lite/js/hyperaudio-lite.js');
  expect(html).toContain('id="hypertranscript"');
  expect(html).toContain('data-m=');
});

// #188 (filed 2023) — the export must carry the semantic speaker class, so a
// published transcript can style and machine-read who is speaking. The
// canonical serializer emits it; this pins that end to end.
test('speakers keep their class in the exported transcript (#188)', async ({ page }) => {
  const html = await exportedHtml(page);
  expect(html).toMatch(/<span[^>]*class="speaker"[^>]*>/);
});

import { test, expect } from '@playwright/test';

// #564 — the exported page carries the editor's copy contract (#467): the
// WHOLE transcript, always; a plain-text and a conservative HTML flavour;
// struck words excluded (they are speech the author removed); and visible
// confirmation, because a clipboard write is otherwise invisible.
//
// The exported page is driven directly here, with its CDN dependencies
// stubbed — this tests OUR script, not hyperaudio-lite's.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const exportedPage = async (page, context) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // strike a word: the copy must leave it out
  await page.evaluate(() => {
    const span = document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')[1];
    span.textContent = 'STRUCKWORD ';   // unique, so its absence is provable
    span.style.textDecoration = 'line-through';
  });
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => {
    document.getElementById('interactive-export-modal').checked = true;
    document.getElementById('interactive-media-filename').value = 'clip.mp4';
    document.getElementById('interactive-export-download').click();
  });
  const download = await downloadPromise;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const html = Buffer.concat(chunks).toString('utf8');

  // the exported page's own dependencies are not under test
  await context.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({
    status: 200,
    contentType: route.request().url().endsWith('.css') ? 'text/css' : 'text/javascript',
    body: '',
  }));
  // Served from the real origin, not setContent: the clipboard API only
  // exists in a secure context, and about:blank is not one.
  await context.route('http://localhost:4173/__exported-transcript.html',
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  const exported = await context.newPage();
  await exported.goto('http://localhost:4173/__exported-transcript.html');
  return exported;
};

test('the exported page copies the whole transcript, struck words excluded (#564)', async ({ page, context }) => {
  const exported = await exportedPage(page, context);
  await exported.click('#ht-copy');
  const copied = await exported.evaluate(() => navigator.clipboard.readText());

  expect(copied.length).toBeGreaterThan(50);       // the whole transcript
  expect(copied).not.toContain('STRUCKWORD');      // ...minus the struck word
  expect(copied).not.toContain('[');               // speakers read "Name: ", not "[Name]"
  expect(copied.split('\n\n').length).toBeGreaterThan(1); // paragraphs survive
});

test('the copy button confirms itself, then returns (#564)', async ({ page, context }) => {
  const exported = await exportedPage(page, context);
  await exported.click('#ht-copy');
  // icon-only, so the confirmation is the checkmark, the colour and the label
  await expect(exported.locator('#ht-copy')).toHaveAttribute('data-copied', '1');
  await expect(exported.locator('#ht-copy')).toHaveAttribute('aria-label', 'Transcript copied');
  await expect(exported.locator('[role="status"]')).toHaveText('Transcript copied to clipboard.');
  // and it goes back, so a second copy is obviously possible
  await expect(exported.locator('#ht-copy')).not.toHaveAttribute('data-copied', '1', { timeout: 4000 });
  await expect(exported.locator('#ht-copy')).toHaveAttribute('aria-label', 'Copy transcript');
  expect((await exported.locator('#ht-copy').textContent()).trim()).toBe(''); // no text, ever
});

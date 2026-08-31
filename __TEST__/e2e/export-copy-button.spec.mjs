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

// Stand in for the clipboard API and record what the page hands it (#606).
// Reading the SYSTEM clipboard back made this test fail intermittently under
// the full gate — an empty read, five times in one session, passing every time
// in isolation. The round trip was never the subject: this file's own header
// says it tests OUR script. Standing in for the API removes a shared resource
// from the assertion and makes the page take its first path every time.
const captureClipboard = (exported) => exported.evaluate(() => {
  window.__copied = null;
  navigator.clipboard.write = async (items) => {
    const item = items[0];
    window.__copied = {
      plain: await (await item.getType('text/plain')).text(),
      html: await (await item.getType('text/html')).text(),
    };
  };
  navigator.clipboard.writeText = async (text) => { window.__copied = { plain: text, html: null }; };
});

test('the exported page copies the whole transcript, as shown (#564/#605)', async ({ page, context }) => {
  const exported = await exportedPage(page, context);
  await captureClipboard(exported);
  await exported.click('#ht-copy');
  // Poll: the stub awaits getType() and blob.text(), so what the page hands
  // over lands a few microtasks after the click. Reading once passed in
  // isolation and failed under a loaded gate — the same race the fallback
  // test below avoids by polling.
  await expect.poll(() => exported.evaluate(() => window.__copied !== null)).toBe(true);
  const handed = await exported.evaluate(() => window.__copied);
  const copied = handed.plain;
  expect(copied.length).toBeGreaterThan(50);       // the whole transcript
  // Struck words are COPIED here (#605): this page links the original media,
  // which still speaks them, and they are visible on the page. An Edited-media
  // export has no struck words in it at all, so its copy is clean without any
  // filter — the decision belongs to the export, not to the copy button.
  expect(copied).toContain('STRUCKWORD');
  expect(copied).not.toContain('[');               // speakers read "Name: ", not "[Name]"
  expect(copied.split('\n\n').length).toBeGreaterThan(1); // paragraphs survive
  // the rich flavour rides along, with the speaker in bold
  expect(handed.html).toContain('<b>');
});

test('a rejected rich copy falls back to plain text (#606)', async ({ page, context }) => {
  // The fallback chain used to be exercised only by accident, whenever the
  // real clipboard misbehaved. Forced here instead, so it is covered on
  // purpose rather than as a side effect of a flaky environment.
  const exported = await exportedPage(page, context);
  await exported.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.write = () => Promise.reject(new Error('no rich clipboard here'));
    navigator.clipboard.writeText = async (text) => { window.__copied = { plain: text, html: null }; };
  });
  await exported.click('#ht-copy');
  await expect.poll(() => exported.evaluate(() => window.__copied && window.__copied.plain.length))
    .toBeGreaterThan(50);
  expect(await exported.evaluate(() => window.__copied.plain)).toContain('STRUCKWORD');
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

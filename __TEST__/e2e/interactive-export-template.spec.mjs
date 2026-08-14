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

const exportedHtml = async (page, navigate = true) => {
  if (navigate) {
    await page.goto('/index.html');
    await page.waitForSelector('#hypertranscript [data-m]');
  }
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
  expect(html).toMatch(/hyperaudio-lite@[\d.]+\/js\/hyperaudio-lite\.js/); // pinned since #571
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

// #563 — an exported transcript is published and shared, so it must say what
// it is a transcript of: in the tab, in a link unfurl, and on the page.
const withTitle = async (page, title) => {
  await page.evaluate(async (t) => {
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    for (let i = 0; i < 50 && window.HyperaudioSave.library.currentId() === null; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await window.HyperaudioSave.library.rename(window.HyperaudioSave.library.currentId(), t);
  }, title);
};

test('the project title reaches the tab, the page and the unfurl (#563)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await withTitle(page, 'Atmosphere Conf 26 — Teon Brooks');
  const html = await exportedHtml(page, false);

  expect(html).toContain('<title>Atmosphere Conf 26 — Teon Brooks</title>');
  expect(html).toContain('<h1 class="ht-title">Atmosphere Conf 26 — Teon Brooks</h1>');
  expect(html).toMatch(/<meta property="og:title" content="Atmosphere Conf 26 — Teon Brooks">/);
  // the description is the transcript's opening words, minus speaker labels
  const desc = html.match(/<meta name="description" content="([^"]*)">/);
  expect(desc).not.toBeNull();
  expect(desc[1].length).toBeGreaterThan(10);
  expect(desc[1]).not.toContain('[Mark]');
  // no placeholder survives into a published page
  expect(html).not.toContain('{title}');
  expect(html).not.toContain('{heading}');
  expect(html).not.toContain('{description}');
});

test('a title with markup characters cannot break out of the page (#563)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await withTitle(page, '<script>alert(1)</script> & "quoted"');
  const html = await exportedHtml(page, false);
  expect(html).not.toContain('<script>alert(1)</script>');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;');
});

test('an untitled export keeps the boilerplate title and shows no empty heading (#563)', async ({ page }) => {
  const html = await exportedHtml(page); // no project, no title
  expect(html).toContain('<title>Hyperaudio – Interactive Transcript</title>');
  expect(html).not.toContain('<h1 class="ht-title">'); // the rule stays in CSS; the element goes
  expect(html).not.toContain('{heading}');
});

// #560 — the exported page links its media by bare filename, so what we WRITE
// must be safe as a filename AND a URL path segment: no spaces to
// percent-encode, nothing a static host will normalise or reject.
test('a media filename with spaces is sanitised, not percent-encoded (#560)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => {
    document.getElementById('interactive-export-modal').checked = true;
    document.getElementById('interactive-media-filename').value = 'my media file.mp4';
    document.getElementById('interactive-export-download').click();
  });
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const html = Buffer.concat(chunks).toString('utf8');

  const videoTag = html.match(/<video[^>]*>/)[0];
  expect(videoTag).toContain('src="my_media_file.mp4"');
  expect(videoTag).not.toContain('%20');   // the media link needs no encoding
  expect(html).not.toContain('my media file.mp4');
  // (the inline caption data: URL is percent-encoded by nature — that is
  // #561's subject, not this one)
});

test('a media URL the user typed is left exactly as entered (#560)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => {
    document.getElementById('interactive-export-modal').checked = true;
    document.getElementById('interactive-media-filename').value = 'https://example.com/a b/clip.mp4';
    document.getElementById('interactive-export-download').click();
  });
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const html = Buffer.concat(chunks).toString('utf8');
  expect(html).toContain('src="https://example.com/a b/clip.mp4"'); // theirs, untouched
});

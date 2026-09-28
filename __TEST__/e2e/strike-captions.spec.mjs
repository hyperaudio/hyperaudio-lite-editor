// Captions follow strikeouts. Striking words with the toolbar button changed
// what is said without an edit in the transcript's text box, so the captions
// (regenerated only while the transcript has focus) kept the struck words —
// and an edited export burned them in, briefly, over the cut.
import { test, expect } from '@playwright/test';

const vtt = (page) => page.evaluate(() => window.HyperaudioSave.getCaptionsVtt());

// select words i..j of the transcript and press the strikethrough button
const strike = async (page, i, j) => {
  const words = await page.evaluate(([a, b]) => {
    const spans = document.querySelectorAll('#hypertranscript [data-m]:not(.speaker)');
    const r = document.createRange();
    r.setStart(spans[a].firstChild, 0);
    r.setEnd(spans[b].firstChild, spans[b].textContent.trimEnd().length);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.getElementById('hypertranscript').focus();
    return [...spans].slice(a, b + 1).map((sp) => sp.textContent.trim());
  }, [i, j]);
  await page.click('#strikethrough');
  return words;
};

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => vtt(page)).toContain('Hyperaudio Lite Editor');
});

test('struck words leave the captions, and undo brings them back', async ({ page }) => {
  const struck = await strike(page, 2, 4);             // "Lite Editor makes"
  expect(struck).toEqual(['Lite', 'Editor', 'makes']);
  await expect.poll(() => vtt(page)).not.toContain('Lite Editor');
  expect(await vtt(page)).toContain('Hyperaudio');       // its neighbours stay

  // the Undo button (hidden on desktop, shown on touch): undo without the
  // transcript having focus, the path that also skipped the captions
  await page.evaluate(() => document.getElementById('transcript-undo').click());
  await expect.poll(() => vtt(page)).toContain('Hyperaudio Lite Editor');
});

test('an edited export burns in no struck words', async ({ page }) => {
  await strike(page, 2, 4);
  await expect.poll(() => vtt(page)).not.toContain('Lite Editor');
  const burned = await page.evaluate(() => {
    const player = document.getElementById('hyperplayer');
    const duration = Number.isFinite(player.duration) ? player.duration : 600;
    const sections = window.getPlayableSections().map((s) => ({ start: s.start, end: Math.min(s.end, duration) }));
    const chunks = window.MediaExportCaptions.buildCaptionChunks(sections, 1, true) || [];
    return chunks.flatMap((c) => (Array.isArray(c) ? c : c.lines.flat())).map((w) => w.text);
  });
  // the first caption without "Lite Editor makes" ("Lite" returns later on,
  // in "Hyperaudio Lite Library", unstruck)
  expect(burned.slice(0, 4)).toEqual(['The', 'Hyperaudio', 'audio', 'and']);
});

test('captions edited by hand are left alone by a strikeout', async ({ page }) => {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display .caption');
  await page.fill('#captions-display .caption:first-child .line1', 'HAND EDITED LINE');
  await expect.poll(() => vtt(page)).toContain('HAND EDITED LINE');
  await page.click('#transcript-editor-btn');
  await page.waitForSelector('#hypertranscript [data-m]');
  await strike(page, 8, 9);
  await page.waitForTimeout(300);
  expect(await vtt(page)).toContain('HAND EDITED LINE');
});

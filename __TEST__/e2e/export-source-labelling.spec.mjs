// #608 — the Export media modal explained one option and not the other.
// "Edited media" carries a live summary ("3 cuts, saves 12.4s"); "Entire
// media" said nothing, so the option that ships someone's ORIGINAL file —
// struck-out speech included — was the one that never said so.
//
// The note appears only when there is something to warn about: with a clean
// transcript both options produce the same media, and a warning about nothing
// is the kind people learn to dismiss unread.
import { test, expect } from '@playwright/test';
import { ladderWav } from './helpers.mjs';

async function loadTenSeconds(page) {
  await page.route('**/__ladder.wav', (route) => route.fulfill({
    body: ladderWav(10), contentType: 'audio/wav',
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
}

const transcript = (struckIndex) => {
  const words = Array.from({ length: 10 }, (_, i) =>
    `<span data-m="${i * 1000}" data-d="1000"${i === struckIndex ? ' style="text-decoration: line-through;"' : ''}>w${i} </span>`);
  return `<article><section><p>${words.join('')}</p></section></article>`;
};

const openExportModal = async (page) => {
  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
};

const noteText = (page, id) => page.evaluate((elId) => {
  const el = document.getElementById(elId);
  if (el === null) return null;
  return getComputedStyle(el).display === 'none' ? '' : el.textContent.trim();
}, id);

// Asserted on the computed style, not on Playwright visibility: an EMPTY div
// has no bounding box, so toBeHidden() passes whether it is display:none or
// merely blank — which would let "always shown, cleared" slip through.
const noteDisplay = (page, id) => page.evaluate(
  (elId) => getComputedStyle(document.getElementById(elId)).display, id);

test('the Entire media option says what it gives you (#608)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // the label itself, always — the option that ships the original file says so
  await expect(page.locator('label:has(#export-source-entire)'))
    .toContainText('original audio or video file');
});

test('the cuts note appears only when there are cuts (#608)', async ({ page }) => {
  await loadTenSeconds(page);

  // nothing struck: both options produce the same media, so no note. Asserted
  // as HIDDEN, not merely empty — clearing the text while leaving the element
  // on screen would pass a text-only check and still show an empty gap.
  await page.evaluate((html) => { document.getElementById('hypertranscript').innerHTML = html; }, transcript(-1));
  await openExportModal(page);
  expect(await noteDisplay(page, 'export-source-note')).toBe('none');

  // strike a word and reopen: now there is something to say
  await page.evaluate(() => { document.getElementById('export-modal').checked = false; });
  await page.evaluate((html) => { document.getElementById('hypertranscript').innerHTML = html; }, transcript(3));
  await openExportModal(page);
  expect(await noteDisplay(page, 'export-source-note')).not.toBe('none');
  const note = await noteText(page, 'export-source-note');
  expect(note).toContain('nothing is cut');
  expect(note).toContain('still in it');
});

test('the Edited media option greys out when there is nothing to edit (#608)', async ({ page }) => {
  await loadTenSeconds(page);
  const labelOpacity = () => page.evaluate(() => {
    const label = document.getElementById('export-source-edited').closest('label');
    return Number(getComputedStyle(label).opacity);
  });
  const radioDisabled = () => page.evaluate(
    () => document.getElementById('export-source-edited').disabled);

  // nothing struck: the option is not available, and must not look available.
  // The radio alone being disabled left the label at full strength.
  await page.evaluate((html) => { document.getElementById('hypertranscript').innerHTML = html; }, transcript(-1));
  await openExportModal(page);
  expect(await radioDisabled()).toBe(true);
  expect(await labelOpacity()).toBeLessThan(1);

  // strike a word and the whole option comes back
  await page.evaluate(() => { document.getElementById('export-modal').checked = false; });
  await page.evaluate((html) => { document.getElementById('hypertranscript').innerHTML = html; }, transcript(3));
  await openExportModal(page);
  expect(await radioDisabled()).toBe(false);
  expect(await labelOpacity()).toBe(1);
});

test('the interactive transcript modal says the media keeps the cuts (#608)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  const openInteractive = () => page.evaluate(() => {
    const m = document.getElementById('interactive-export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });

  // clean transcript: nothing to warn about — hidden, not just empty
  await openInteractive();
  expect(await noteDisplay(page, 'interactive-cuts-note')).toBe('none');

  await page.evaluate(() => {
    document.getElementById('interactive-export-modal').checked = false;
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.style.textDecoration = 'line-through';
  });
  await openInteractive();
  expect(await noteDisplay(page, 'interactive-cuts-note')).not.toBe('none');
  const note = await noteText(page, 'interactive-cuts-note');
  expect(note).toContain('links your original media');
  expect(note).toContain('Edited media');
});

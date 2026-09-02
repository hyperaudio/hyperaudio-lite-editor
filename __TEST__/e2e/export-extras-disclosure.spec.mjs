// #616 — the Export media modal had grown long enough to scroll, so the files
// that come ALONGSIDE the media (interactive transcript, VTT, SRT, project,
// zip) collapse under "Also download…".
//
// The danger in collapsing them is that these options are REMEMBERED across
// sessions: something ticked last week, now hidden, would export extra files
// with nothing on screen to explain it. So the disclosure has to declare its
// state — a count in the summary, and it opens itself when anything is on.
import { test, expect } from '@playwright/test';

const openModal = async (page) => {
  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
};

const disclosure = (page) => page.evaluate(() => {
  const box = document.getElementById('export-extras');
  return {
    shown: getComputedStyle(box).display !== 'none',
    open: box.open === true,
    summary: document.getElementById('export-extras-count').textContent.trim(),
    rowsInside: [...box.querySelectorAll('label')].map((l) => l.id),
  };
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(() => {
    // start from a known state: nothing remembered
    localStorage.removeItem('hyperaudioExportOptions');
    [...document.querySelectorAll('#export-retime, #export-vtt, #export-srt, #export-project')]
      .forEach((c) => { if (c) c.checked = false; });
  });
});

test('the extras collapse, and the media options stay visible (#616)', async ({ page }) => {
  await openModal(page);
  const d = await disclosure(page);
  expect(d.shown).toBe(true);
  expect(d.rowsInside).toEqual([
    'export-retime-row', 'export-vtt-row', 'export-srt-row', 'export-project-row',
  ]);
  // zip stays OUT: packaging rather than an extra file, and its offer has to be
  // visible the moment a second output is chosen
  expect(await page.evaluate(
    () => document.getElementById('export-extras').contains(document.getElementById('export-zip-row')),
  )).toBe(false);
  // burn stays OUT: it changes the video itself rather than adding a file
  expect(await page.evaluate(
    () => document.getElementById('export-extras').contains(document.getElementById('export-burn-row')),
  )).toBe(false);
});

test('the zip offer names what it is packaging (#616)', async ({ page }) => {
  // The options that cause this row to appear are inside a collapsed panel, so
  // without a count the offer shows up with no visible cause.
  await openModal(page);
  const zipLabel = () => page.evaluate(
    () => document.getElementById('export-zip-count').textContent.trim());

  await page.evaluate(() => {
    const c = document.getElementById('export-retime');
    c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(await zipLabel()).toBe('(2 files, one folder)'); // the media, plus one

  await page.evaluate(() => {
    const c = document.getElementById('export-srt');
    c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(await zipLabel()).toBe('(3 files, one folder)');
});

test('nothing selected: collapsed and silent (#616)', async ({ page }) => {
  await openModal(page);
  const d = await disclosure(page);
  expect(d.open).toBe(false);
  expect(d.summary).toBe('');
});

test('a selected extra is never hidden silently (#616)', async ({ page }) => {
  await openModal(page);
  await page.evaluate(() => {
    const c = document.getElementById('export-retime');
    c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const d = await disclosure(page);
  // the COUNT is what keeps a collapsed panel honest — it does not force
  // itself open, but it never leaves a ticked option unannounced
  expect(d.summary).toBe('(1 selected)');

  await page.evaluate(() => {
    const c = document.getElementById('export-srt');
    c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect((await disclosure(page)).summary).toBe('(2 selected)');
});

test('a remembered option is announced, though the panel stays closed (#616)', async ({ page }) => {
  // the case the count exists for: ticked in an earlier session, and the panel
  // is closed by default, so the summary is the only thing that can say so
  await page.evaluate(() => {
    localStorage.setItem('hyperaudioExportOptions', JSON.stringify({
      burn: false, adjust: false, speed: 1, retime: true, vtt: false, srt: false, project: false,
    }));
  });
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await openModal(page);
  const d = await disclosure(page);
  expect(d.summary).toBe('(1 selected)');
  expect(d.open, 'closed by default, even with something selected').toBe(false);
});

test('opening the panel is remembered (#616)', async ({ page }) => {
  await openModal(page);
  expect((await disclosure(page)).open).toBe(false);
  await page.evaluate(() => {
    const box = document.getElementById('export-extras');
    box.open = true;
    box.dispatchEvent(new Event('toggle'));
  });
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await openModal(page);
  expect((await disclosure(page)).open, 'still open on the next visit').toBe(true);
});

test('collapsing does not turn an extra off (#616)', async ({ page }) => {
  await openModal(page);
  await page.evaluate(() => {
    const c = document.getElementById('export-retime');
    c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('export-extras').open = false; // collapse it by hand
  });
  // the export reads `checked && row.style.display !== 'none'`, so the row must
  // stay laid out inside the closed panel — collapsed is not off
  const state = await page.evaluate(() => ({
    checked: document.getElementById('export-retime').checked,
    rowDisplay: document.getElementById('export-retime-row').style.display,
  }));
  expect(state.checked).toBe(true);
  expect(state.rowDisplay).toBe('flex');
});

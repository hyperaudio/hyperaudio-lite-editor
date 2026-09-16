// #628 — a failed transcription paints an error card into #hypertranscript.
// handleError clears busy first, which restores contenteditable, so the card
// was typeable; worse, it was captured as the project's transcript: pressing
// Save wrote the card, with zero words, over the open project. Cards are
// painted through showTranscriptNotice now, and no state write may capture
// one.
import { test, expect } from '@playwright/test';

const ERROR_CARD = '<div class="vertically-centre"><center>Sorry.<br/>Transcription failed.</center></div>';

const paintErrorCard = (page) => page.evaluate((html) => {
  // exactly the order an engine's handleError uses
  setTranscriptBusy(false);
  showTranscriptNotice(html);
}, ERROR_CARD);

const stateFile = (page, name) => page.evaluate(async (name) => {
  const id = window.HyperaudioSave.library.currentId();
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle('work')).getDirectoryHandle(String(id));
  try {
    const raw = JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
    return { words: JSON.parse(raw.json).transcript.words.length, html: String(raw.html) };
  } catch (e) {
    return null;   // never written
  }
}, name);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.library.currentId())).not.toBeNull();
});

test('the error card is a message, not a document: it cannot be typed into (#628)', async ({ page }) => {
  await paintErrorCard(page);
  const card = page.locator('#hypertranscript [data-transcript-notice]');
  await expect(card).toHaveAttribute('contenteditable', 'false');

  const before = await card.textContent();
  await card.click();
  await page.keyboard.type('oh dear');
  expect(await card.textContent()).toBe(before);
});

test('Save after a failed transcription refuses, and the project keeps its transcript (#628)', async ({ page }) => {
  const atRest = await stateFile(page, 'saved.json');
  expect(atRest.words).toBeGreaterThan(100);       // the intro, as seeded

  await paintErrorCard(page);
  // the refusal is a dialog, so dismiss it before awaiting the call
  const refusal = page.evaluate(() => window.HyperaudioSave.saveProject());
  await expect(page.locator('#project-dialog-message')).toContainText('showing a message, not a transcript');
  await page.click('#project-dialog-confirm');
  expect(await refusal).toBe(false);

  // the saved state is untouched — this is the data loss the issue is about
  const after = await stateFile(page, 'saved.json');
  expect(after.words).toBe(atRest.words);
  expect(after.html).not.toContain('Transcription failed');
});

test('an autosave triggered elsewhere never captures the card either (#628)', async ({ page }) => {
  await paintErrorCard(page);
  // a legitimate edit outside the transcript, which schedules an autosave
  await page.evaluate(() => {
    const s = document.getElementById('summary');
    s.textContent = 'a note';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(3000);   // past the 1500ms debounce

  const draft = await stateFile(page, 'draft.json');
  if (draft !== null) {
    expect(draft.html).not.toContain('Transcription failed');
    expect(draft.words).toBeGreaterThan(100);
  }
});

test('the loader is a notice too, and saving works again once a transcript returns (#628)', async ({ page }) => {
  const original = await page.evaluate(() => document.getElementById('hypertranscript').innerHTML);

  await page.evaluate(() => {
    showTranscriptNotice('<center class="transcribing-msg">Preparing model…</center>');
    setTranscriptBusy(true);
  });
  await expect(page.locator('#hypertranscript [data-transcript-notice]')).toHaveAttribute('contenteditable', 'false');
  // the engines paint progress into this element — it must stay reachable
  expect(await page.evaluate(() => document.querySelector('.transcribing-msg') !== null)).toBe(true);

  // the transcript comes back: nothing is left stuck
  await page.evaluate((html) => {
    setTranscriptBusy(false);
    document.getElementById('hypertranscript').innerHTML = html;
  }, original);
  expect(await page.evaluate(() => document.querySelector('#hypertranscript [data-transcript-notice]'))).toBeNull();

  await page.click('#hypertranscript span[data-m]');
  await page.keyboard.type('Hello');
  expect(await page.evaluate(() => window.HyperaudioSave.saveProject())).not.toBe(false);
  const saved = await stateFile(page, 'saved.json');
  expect(saved.html).toContain('Hello');
});

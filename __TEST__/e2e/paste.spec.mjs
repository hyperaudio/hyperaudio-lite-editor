// #487 — pasting into the transcript inserts TEXT, not markup.
//
// The handler took the clipboard's text/plain and fed it to
// execCommand("insertHTML"), which parses it: anything between < and > became an
// element rather than characters. Pasting the literal "<inaudible>" produced an
// empty <inaudible> element, so the word rendered as nothing and never reached
// the saved JSON — silent, unrecoverable loss of what the user just pasted.
// Recognised tags fared no better, injecting real <b>/<i> into the word spans.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

// Paste `text` as text/plain with the caret at `offset` inside word span `index`.
const pasteInto = (page, index, offset, text) => page.evaluate(({ index, offset, text }) => {
  const ht = document.getElementById('hypertranscript');
  ht.focus();
  const span = [...ht.querySelectorAll('span[data-m]:not(.speaker)')][index];
  const range = document.createRange();
  range.setStart(span.firstChild, offset);
  range.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  ht.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, { index, offset, text });

const state = (page) => page.evaluate(() => {
  const ht = document.getElementById('hypertranscript');
  return {
    text: ht.textContent,
    elements: ht.querySelectorAll('span[data-m]:not(.speaker)').length,
    // anything that is not a timed word span is foreign to the transcript
    foreign: [...ht.querySelectorAll('*')]
      .filter((el) => !(el.tagName === 'SPAN' || el.tagName === 'P'
        || el.tagName === 'ARTICLE' || el.tagName === 'SECTION'))
      .map((el) => el.tagName),
  };
});

test('a pasted word in angle brackets survives as text (#487)', async ({ page }) => {
  const before = await state(page);
  await pasteInto(page, 0, 0, '<inaudible>');

  const after = await state(page);
  expect(after.text).toContain('<inaudible>');   // pre-fix: the word vanished
  expect(after.foreign).toEqual([]);             // pre-fix: ['INAUDIBLE']
  expect(after.elements).toBe(before.elements);
});

test('pasted markup arrives as literal characters, not elements (#487)', async ({ page }) => {
  await pasteInto(page, 1, 0, 'A<b>bold</b>B');

  const after = await state(page);
  expect(after.text).toContain('A<b>bold</b>B');  // every character, verbatim
  expect(after.foreign).toEqual([]);              // pre-fix: ['B']
});

test('pasting keeps the word span and its timing intact (#487)', async ({ page }) => {
  const timing = await page.evaluate(() => {
    const s = [...document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')][2];
    return { m: s.getAttribute('data-m'), d: s.getAttribute('data-d') };
  });

  // mid-word, not offset 0: a caret at the start of a span's text node is the
  // same document position as the end of the previous one, so contenteditable
  // attaches the insertion to the PREVIOUS word — long-standing behaviour, and
  // nothing to do with how the paste is inserted
  await pasteInto(page, 2, 2, 'PASTED');

  const after = await page.evaluate(() => {
    const s = [...document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')][2];
    return { m: s.getAttribute('data-m'), d: s.getAttribute('data-d'), text: s.textContent };
  });
  expect(after.m).toBe(timing.m);
  expect(after.d).toBe(timing.d);
  expect(after.text).toContain('PASTED');
});

test('ordinary text still pastes normally (#487)', async ({ page }) => {
  await pasteInto(page, 0, 0, 'hello world ');
  expect(await page.locator('#hypertranscript').textContent()).toContain('hello world');
});

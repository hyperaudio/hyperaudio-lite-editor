// #792 — a word retyped after a speaker label became part of the label.
// Deleting the first word after "[Mark] " also took the label's trailing
// space (WebKit's smart delete) and left the caret at the label's end, so
// the retyped word went INTO the label span. The sanitise pass split the
// label back out, but the leftover kept the parent's speaker class and zero
// duration: bold, untimed, hidden with Speakers off. The leftover now moves
// into the next word span, the emptied original, which still has its timing.
import { test, expect, webkit, chromium } from '@playwright/test';

// the first label of the intro transcript and the word span after it
const around = (page) => page.evaluate(() => {
  const label = document.querySelector('#hypertranscript .speaker');
  const next = label.nextElementSibling;
  return {
    label: { text: label.textContent, speaker: label.classList.contains('speaker') },
    next: { text: next.textContent, speaker: next.classList.contains('speaker'), m: next.getAttribute('data-m'), d: next.getAttribute('data-d') },
    labels: document.querySelectorAll('#hypertranscript .speaker').length,
  };
});

// The broken state, built directly so both engines see the same thing: the
// label without its trailing space, the word span emptied to a space, and
// the caret at the end of the label.
const breakIt = (page) => page.evaluate(() => {
  const label = document.querySelector('#hypertranscript .speaker');
  const next = label.nextElementSibling;
  label.textContent = label.textContent.trimEnd();
  next.textContent = ' ';
  const range = document.createRange();
  range.setStart(label.firstChild, label.firstChild.length);
  range.collapse(true);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  document.getElementById('hypertranscript').focus();
  return { labels: document.querySelectorAll('#hypertranscript .speaker').length, m: next.getAttribute('data-m'), d: next.getAttribute('data-d') };
});

for (const [engineName, engine] of [['WebKit', webkit], ['Chromium', chromium]]) {
  test(`${engineName}: a word typed at the end of a label becomes a word again, not a label (#792)`, async () => {
    let browser;
    try {
      browser = await engine.launch();
    } catch (e) {
      test.skip(true, `${engineName} build not installed: ${e.message}`);
      return;
    }
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto('http://localhost:4173/index.html');
      await page.waitForSelector('#hypertranscript .speaker');
      const before = await breakIt(page);
      // slowly, so the first letter's sanitise pass runs before the next
      // letter arrives: the caret has to follow the moved text
      await page.keyboard.type('The', { delay: 400 });

      await expect.poll(async () => (await around(page)).next.text, { timeout: 5000 }).toBe('The ');
      const after = await around(page);
      expect(after.label).toEqual({ text: '[Mark] ', speaker: true });
      expect(after.next.speaker).toBe(false);
      expect(after.next.m).toBe(before.m);          // the word's own timing
      expect(after.next.d).toBe(before.d);
      expect(after.labels).toBe(before.labels);     // no label gained
    } finally {
      await browser.close();
    }
  });
}

// The steps as the tester did them, in the engine where they reproduce.
test('WebKit: the first word after a label, deleted and retyped, is a word (#792)', async () => {
  let browser;
  try {
    browser = await webkit.launch();
  } catch (e) {
    test.skip(true, `WebKit build not installed: ${e.message}`);
    return;
  }
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto('http://localhost:4173/index.html');
    await page.waitForSelector('#hypertranscript .speaker');
    const before = await around(page);
    expect(before.next.text).toBe('The ');

    await page.dblclick('#hypertranscript .speaker + span[data-m]');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('The', { delay: 400 });

    await expect.poll(async () => {
      const a = await around(page);
      return a.label.text + '|' + a.next.text;
    }, { timeout: 5000 }).toBe('[Mark] |The ');
    const after = await around(page);
    expect(after.next.speaker).toBe(false);
    expect(after.next.d).toBe(before.next.d);
    expect(after.labels).toBe(before.labels);
  } finally {
    await browser.close();
  }
});

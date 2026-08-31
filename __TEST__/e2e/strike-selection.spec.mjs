// #613 — striking a word also struck the word before it, in Safari only.
//
// intersectsNode() is true for a span the range merely touches, and the two
// engines anchor a drag differently when it starts on a word's first letter:
//
//   WebKit    selected "charlie"  anchored in text("bravo ")@6   <- previous span
//   Chromium  selected "charlie"  anchored in text("charlie ")@0
//
// So in WebKit the previous span held the range's start boundary while
// contributing no characters, and the leading-space trim could not see it —
// the selected string starts cleanly at the word.
//
// Launches WebKit itself: the suite's default project is Chromium, where this
// does not reproduce at all.
import { test, expect, webkit, chromium } from '@playwright/test';

const MARKUP = '<article><section><p>'
  + '<span data-m="0" data-d="400">alpha </span>'
  + '<span data-m="400" data-d="400">bravo </span>'
  + '<span data-m="800" data-d="400">charlie </span>'
  + '<span data-m="1200" data-d="400">delta </span>'
  + '</p></section></article>';

const WORD = '#hypertranscript span[data-m]:nth-of-type(3)'; // "charlie"

// Repeat a selection WITHOUT resetting the transcript, so the toggle acts on
// whatever state the previous call left behind.
async function strikeAgain(page, how) {
  return strikeVia(page, how, true);
}

async function strikeVia(page, how, keepState) {
  if (keepState !== true) {
    await page.evaluate((m) => {
      document.getElementById('hypertranscript').innerHTML = m;
      window.getSelection().removeAllRanges();
    }, MARKUP);
  } else {
    await page.evaluate(() => window.getSelection().removeAllRanges());
  }
  const box = await page.locator(WORD).boundingBox();
  const midY = box.y + box.height / 2;
  if (how === 'dblclick') {
    await page.dblclick(WORD);
  } else if (how === 'ltr') {
    await page.mouse.move(box.x + 1, midY);            // ON the first letter
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 3, midY, { steps: 8 });
    await page.mouse.up();
  } else if (how === 'rtl') {
    await page.mouse.move(box.x + box.width - 3, midY);
    await page.mouse.down();
    await page.mouse.move(box.x + 1, midY, { steps: 8 });
    await page.mouse.up();
  } else if (how === 'two-words') {
    const next = await page.locator('#hypertranscript span[data-m]:nth-of-type(4)').boundingBox();
    await page.mouse.move(box.x + 1, midY);
    await page.mouse.down();
    await page.mouse.move(next.x + next.width - 3, next.y + next.height / 2, { steps: 10 });
    await page.mouse.up();
  }
  await page.click('#strikethrough');
  await page.waitForTimeout(120);
  return page.evaluate(() =>
    [...document.querySelectorAll('#hypertranscript [data-m]')]
      .filter((s) => (s.style.textDecoration || '').includes('line-through'))
      .map((s) => s.textContent.trim()));
}

for (const [engineName, engine] of [['WebKit', webkit], ['Chromium', chromium]]) {
  test(`${engineName}: a strike covers only the words actually selected (#613)`, async () => {
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
      await page.waitForSelector('#hypertranscript [data-m]');

      // the case that was broken: the drag begins on the word's first letter
      expect(await strikeVia(page, 'ltr'), 'drag from the first letter').toEqual(['charlie']);
      expect(await strikeVia(page, 'rtl'), 'drag right-to-left').toEqual(['charlie']);
      expect(await strikeVia(page, 'two-words'), 'two words').toEqual(['charlie', 'delta']);
      // and the case that always worked, which the fix must not disturb
      expect(await strikeVia(page, 'dblclick'), 'double-click').toEqual(['charlie']);

      // The SAME span set decides which way the toggle goes:
      //   selectedSpans.every(isStruck) ? unstrikeElement : strikeoutElement
      // so a wrong set breaks removal exactly as it breaks application. The
      // first version of this spec covered only application, because it was
      // written from the bug report rather than from what the function decides.
      expect(await strikeVia(page, 'ltr'), 'strike, to be undone').toEqual(['charlie']);
      expect(await strikeAgain(page, 'ltr'), 'unstrike by the same drag').toEqual([]);
      expect(await strikeAgain(page, 'dblclick'), 'unstrike by double-click').toEqual(['charlie']);

      // and a selection covering one struck and one unstruck word STRIKES both
      // rather than clearing — every() is false, so the action is application
      expect(await strikeVia(page, 'ltr'), 'one struck to begin with').toEqual(['charlie']);
      expect(await strikeAgain(page, 'two-words'), 'mixed selection strikes').toEqual(['charlie', 'delta']);
    } finally {
      await browser.close();
    }
  });
}

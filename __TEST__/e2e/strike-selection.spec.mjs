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

// #701 — a selection that picked up the whitespace before its first word
// dropped one word per leading space character (up to all but the last). The
// serialised transcript indents every span, so a gap of "\n    " sits between
// words — and a drag often starts in it, after a speaker label especially.
const INDENTED = '<article><section><p>\n'
  + '    <span data-m="0" data-d="0" class="speaker">[Demo] </span>\n'
  + '    <span data-m="0" data-d="400">This </span>\n'
  + '    <span data-m="400" data-d="400">is </span>\n'
  + '    <span data-m="800" data-d="400">the </span>\n'
  + '    <span data-m="1200" data-d="400">first </span>\n'
  + '    <span data-m="1600" data-d="400">example </span>\n'
  + '</p></section></article>';

// Select from `offset` in the indent before "This" to the end of word `lastWord`
// (1 = "This"), strike, and return what is struck.
async function strikeFromIndent(page, offset, lastWord) {
  await page.evaluate(([m, off, last]) => {
    const t = document.getElementById('hypertranscript');
    t.innerHTML = m;
    const label = t.querySelector('.speaker');
    const gap = label.nextSibling;                       // "\n    "
    const words = [...t.querySelectorAll('span[data-m]:not(.speaker)')];
    const range = document.createRange();
    range.setStart(gap, off);
    range.setEnd(words[last - 1].firstChild, words[last - 1].textContent.trimEnd().length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, [INDENTED, offset, lastWord]);
  await page.click('#strikethrough');
  await page.waitForTimeout(120);
  return page.evaluate(() =>
    [...document.querySelectorAll('#hypertranscript [data-m]:not(.speaker)')]
      .filter((s) => (s.style.textDecoration || '').includes('line-through'))
      .map((s) => s.textContent.trim()));
}

for (const [engineName, engine] of [['WebKit', webkit], ['Chromium', chromium]]) {
  test(`${engineName}: a selection starting in the space before a word strikes that word too (#701)`, async () => {
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
      for (const offset of [0, 1, 2, 3, 4, 5]) {
        expect(await strikeFromIndent(page, offset, 2), `two words, from offset ${offset}`)
          .toEqual(['This', 'is']);
        expect(await strikeFromIndent(page, offset, 4), `four words, from offset ${offset}`)
          .toEqual(['This', 'is', 'the', 'first']);
      }
      // what the removed loop was for, still true: a selection that only
      // touches a word's trailing space does not strike that word
      const touched = await page.evaluate((m) => {
        const t = document.getElementById('hypertranscript');
        t.innerHTML = m;
        const words = [...t.querySelectorAll('span[data-m]:not(.speaker)')];
        const range = document.createRange();
        range.setStart(words[0].firstChild, 4);            // "This| "
        range.setEnd(words[2].firstChild, 3);              // "the"
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      }, INDENTED);
      expect(touched).toBe(true);
      await page.click('#strikethrough');
      await page.waitForTimeout(120);
      expect(await page.evaluate(() =>
        [...document.querySelectorAll('#hypertranscript [data-m]:not(.speaker)')]
          .filter((s) => (s.style.textDecoration || '').includes('line-through'))
          .map((s) => s.textContent.trim()))).toEqual(['is', 'the']);
    } finally {
      await browser.close();
    }
  });
}

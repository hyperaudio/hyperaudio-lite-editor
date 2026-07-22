// #394 — joining two words (deleting the boundary space) must merge their timed
// spans into one, the inverse of the existing word-split. Drives the shipped
// editor: simulate the contenteditable result of deleting the space (the first
// span loses its trailing space), fire blur, and check the merge + timings.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

// Strip the trailing space from the Nth non-speaker word span in the first
// paragraph (what contenteditable leaves after the user deletes a word gap),
// then blur. Returns before/after facts for assertions.
const joinAt = (page, indices) => page.evaluate((idxs) => {
  const t = document.querySelector('#hypertranscript');
  const p = t.querySelector('p');
  const spans = [...p.querySelectorAll('span[data-m]')].filter((s) => !s.classList.contains('speaker'));
  const chosen = idxs.map((i) => spans[i]);
  const before = chosen.map((s) => ({
    text: s.textContent, m: +s.getAttribute('data-m'), d: +s.getAttribute('data-d'),
  }));
  const totalBefore = t.querySelectorAll('span[data-m]').length;
  // delete the boundary space after every chosen span except the last in the run
  for (let k = 0; k < chosen.length - 1; k++) {
    chosen[k].textContent = chosen[k].textContent.replace(/\s+$/, '');
  }
  t.dispatchEvent(new Event('blur'));
  const first = before[0];
  const merged = t.querySelector(`span[data-m="${first.m}"]`);
  return {
    before, totalBefore,
    mergedText: merged ? merged.textContent : null,
    mergedM: merged ? +merged.getAttribute('data-m') : null,
    mergedD: merged ? +merged.getAttribute('data-d') : null,
    totalAfter: t.querySelectorAll('span[data-m]').length,
  };
}, indices);

test('joining two words merges their spans (start of first, end of last)', async ({ page }) => {
  const r = await joinAt(page, [1, 2]);
  const [a, b] = r.before;
  expect(r.mergedText).toBe(a.text.replace(/\s+$/, '') + b.text);
  expect(r.mergedM).toBe(a.m);
  expect(r.mergedD).toBe(b.m + b.d - a.m);          // duration spans to end of 2nd
  expect(r.totalAfter).toBe(r.totalBefore - 1);      // one span fewer
});

test('joining three words (chain) collapses to a single span', async ({ page }) => {
  const r = await joinAt(page, [1, 2, 3]);
  const [a, , c] = r.before;
  expect(r.mergedText).toBe(r.before.map((w, i) => i < 2 ? w.text.replace(/\s+$/, '') : w.text).join(''));
  expect(r.mergedM).toBe(a.m);
  expect(r.mergedD).toBe(c.m + c.d - a.m);           // end of the third word
  expect(r.totalAfter).toBe(r.totalBefore - 2);      // two spans fewer
});

test('retyping a word\'s first letter reflows the leaked char back, keeping original timings', async ({ page }) => {
  // Delete the "E" of "Editor" and retype it: contenteditable leaks the letter
  // into the previous span's trailing space ("Lite " -> "Lite E", "Editor " ->
  // "ditor "). On blur it must reflow to "Lite " + "Editor " with the ORIGINAL
  // data-m/data-d on both spans (#394).
  const r = await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    const spans = [...t.querySelectorAll('span[data-m]')].filter((s) => !s.classList.contains('speaker'));
    const lite = spans.find((s) => s.textContent.trim() === 'Lite');
    const editor = lite.nextElementSibling;
    const orig = {
      liteM: +lite.getAttribute('data-m'), liteD: +lite.getAttribute('data-d'),
      editorM: +editor.getAttribute('data-m'), editorD: +editor.getAttribute('data-d'),
    };
    lite.textContent = lite.textContent.replace(/\s+$/, '') + ' E';  // "Lite E"
    editor.textContent = editor.textContent.slice(1);               // "ditor "
    t.dispatchEvent(new Event('blur'));
    const la = t.querySelector(`span[data-m="${orig.liteM}"]`);
    const ea = t.querySelector(`span[data-m="${orig.editorM}"]`);
    return { orig, lite: la && { t: la.textContent, m: +la.getAttribute('data-m'), d: +la.getAttribute('data-d') },
      editor: ea && { t: ea.textContent, m: +ea.getAttribute('data-m'), d: +ea.getAttribute('data-d') } };
  });
  expect(r.lite).toEqual({ t: 'Lite ', m: r.orig.liteM, d: r.orig.liteD });
  expect(r.editor).toEqual({ t: 'Editor ', m: r.orig.editorM, d: r.orig.editorD });
});

test('splitting a word re-indexes the player wordArr so the new spans can highlight', async ({ page }) => {
  // A stale wordArr is why split words don't highlight; after a split (span
  // count changes) the editor must rebuild it to match the DOM (#394).
  const r = await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    const inst = window.hyperaudioInstance;
    const domBefore = t.querySelectorAll('span[data-m]').length;
    const span = [...t.querySelectorAll('span[data-m]')].find((s) => s.textContent.trim() === 'makes');
    span.textContent = 'ma kes ';                       // add a space -> split on blur
    t.dispatchEvent(new Event('blur'));
    const domNodes = [...t.querySelectorAll('span[data-m]')];
    const arrNodes = inst.wordArr.map((w) => w.n);
    return {
      grew: t.querySelectorAll('span[data-m]').length === domBefore + 1,
      arrMatchesDom: arrNodes.length === domNodes.length && domNodes.every((n) => arrNodes.includes(n)),
    };
  });
  expect(r.grew).toBe(true);
  expect(r.arrMatchesDom).toBe(true);
});

test('a clean transcript is untouched on blur (no spurious merges)', async ({ page }) => {
  const { before, after } = await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    const before = t.querySelectorAll('span[data-m]').length;
    t.dispatchEvent(new Event('blur'));       // no edit — every span keeps its trailing space
    const after = t.querySelectorAll('span[data-m]').length;
    return { before, after };
  });
  expect(after).toBe(before);
});

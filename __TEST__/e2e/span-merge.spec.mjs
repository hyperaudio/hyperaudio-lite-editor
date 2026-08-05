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

test('typing a speaker name gets labelled as a speaker, not split as words (#416)', async ({ page }) => {
  // Typing "[Maria] " at the start of a word span must survive normalization
  // (bracketed text belongs to sanitise's speaker pass) — the regression split
  // it into a plain "[Maria] " word span, stealing timing and never labelling.
  await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    t.focus();
    const p = t.querySelectorAll('p')[1]; // a paragraph without a speaker
    const span = p.querySelector('span[data-m]');
    window.__orig = { m: span.getAttribute('data-m'), d: span.getAttribute('data-d') };
    span.textContent = '[Maria] ' + span.textContent;
    document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  });
  await page.waitForTimeout(1400); // past sanitise's 1s debounce
  const r = await page.evaluate(() => {
    const p = document.querySelectorAll('#hypertranscript p')[1];
    const speaker = p.querySelector('span.speaker');
    const word = p.querySelector('span[data-m]:not(.speaker)');
    return {
      speakerText: speaker ? speaker.textContent.trim() : null,
      speakerD: speaker ? speaker.getAttribute('data-d') : null,
      wordM: word.getAttribute('data-m'),
      wordD: word.getAttribute('data-d'),
      orig: window.__orig,
    };
  });
  expect(r.speakerText).toBe('[Maria]');
  expect(r.speakerD).toBe('0');                 // speaker spans carry no duration
  expect(r.wordM).toBe(r.orig.m);               // the word's timing is untouched
  expect(r.wordD).toBe(r.orig.d);
});

test('contenteditable style pollution is scrubbed; functional styles survive (#415)', async ({ page }) => {
  const r = await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    const spans = [...t.querySelectorAll('span[data-m]')].filter((s) => !s.classList.contains('speaker'));
    // WebKit-style pollution: font-size on a word, a style-only wrapper span
    spans[1].setAttribute('style', 'font-size: 13pt;');
    spans[1].insertAdjacentHTML('afterend', '<span style="font-size: 13pt;"> </span>');
    // functional styles that MUST survive: a struck word, a hidden speaker
    spans[2].style.textDecoration = 'line-through';
    spans[2].style.fontSize = '13pt';                    // struck + polluted
    const speaker = t.querySelector('span.speaker');
    if (speaker) speaker.style.display = 'none';
    t.dispatchEvent(new Event('blur'));
    return {
      pollutedGone: !spans[1].hasAttribute('style'),
      wrapperGone: t.querySelector('span[style*="font-size"]:not([data-m])') === null,
      struckKept: spans[2].style.textDecoration.includes('line-through'),
      struckPollutionGone: spans[2].style.fontSize === '',
      speakerDisplayKept: speaker ? speaker.style.display === 'none' : true,
      textIntact: spans[1].textContent.length > 0,
    };
  });
  expect(r).toEqual({
    pollutedGone: true,
    wrapperGone: true,
    struckKept: true,
    struckPollutionGone: true,
    speakerDisplayKept: true,
    textIntact: true,
  });
});

test('the caret survives join/split normalization on the debounced pass', async ({ page }) => {
  // The repairs rewrite text nodes, which used to throw the caret to the start
  // of the affected word mid-edit. It's now saved as a character offset and
  // re-resolved after the pass.
  const abs = () => page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(t);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length;
  });

  await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    t.focus();
    const spans = [...t.querySelectorAll('span[data-m]')].filter((s) => !s.classList.contains('speaker'));
    const a = spans[1];
    a.textContent = a.textContent.replace(/\s+$/, '');   // join: user deleted the boundary space
    const sel = getSelection();
    const r = document.createRange();
    r.setStart(a.firstChild, a.firstChild.length);       // caret at the join point
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  });
  const before = await abs();
  await page.waitForTimeout(1400);                       // debounced sanitise fires
  expect(await abs()).toBe(before);
  // and the merge actually happened (caret preserved on the merged span)
  expect(await page.evaluate(() => getSelection().anchorNode.nodeValue)).toContain('HyperaudioLite');
});

test('a non-collapsed selection survives a rewrite on the debounced pass', async ({ page }) => {
  await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    t.focus();
    const spans = [...t.querySelectorAll('span[data-m]')].filter((s) => !s.classList.contains('speaker'));
    spans[1].textContent = spans[1].textContent.replace(/\s+$/, '');  // pending join elsewhere
    const makes = spans.find((s) => s.textContent.trim() === 'makes');
    const sel = getSelection();
    const r = document.createRange();
    r.setStart(makes.firstChild, 0);
    r.setEnd(makes.firstChild, 5);                                    // "makes" selected
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  });
  await page.waitForTimeout(1400);
  expect(await page.evaluate(() => getSelection().toString())).toBe('makes');
});

test('merge and split in the same pass still re-index wordArr (net-zero span count)', async ({ page }) => {
  const r = await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    const spans = [...t.querySelectorAll('span[data-m]')].filter((s) => !s.classList.contains('speaker'));
    spans[5].textContent = spans[5].textContent.replace(/\s+$/, '');                        // join: −1 span
    spans[8].textContent = spans[8].textContent.trim().replace(/^(..)/, '$1 ') + ' ';       // split: +1 span
    t.dispatchEvent(new Event('blur'));
    const domNodes = [...t.querySelectorAll('span[data-m]')];
    const arrNodes = window.hyperaudioInstance.wordArr.map((w) => w.n);
    return {
      sameLength: domNodes.length === arrNodes.length,
      allLive: arrNodes.every((n) => domNodes.includes(n)),
      allIndexed: domNodes.every((n) => arrNodes.includes(n)),
    };
  });
  expect(r).toEqual({ sameLength: true, allLive: true, allIndexed: true });
});

test('normalization is skipped during IME composition and runs after it ends', async ({ page }) => {
  const r = await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    t.focus();
    const spans = [...t.querySelectorAll('span[data-m]')].filter((s) => !s.classList.contains('speaker'));
    const a = spans[10];
    a.textContent = a.textContent.replace(/\s+$/, '');                // pending join
    document.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    t.dispatchEvent(new Event('blur'));
    const untouchedWhileComposing = a.isConnected && !/\s$/.test(a.textContent);
    document.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    t.dispatchEvent(new Event('blur'));
    const mergedAfter = !a.isConnected || /\s$/.test(a.textContent);
    return { untouchedWhileComposing, mergedAfter };
  });
  expect(r).toEqual({ untouchedWhileComposing: true, mergedAfter: true });
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

// The transcript models words and timings, not rich text — but #hypertranscript
// is a plain contenteditable, so the browser's own formatting applied anyway:
// ⌘B over a selection wrapped the word spans in <b>, and the writer then
// flattened it away on save, silently discarding what the user had applied.
//
// Measured while writing this: headless Chromium treats Ctrl+B in contenteditable
// as inert (no bold, and no beforeinput), and document.execCommand('bold') raises
// no beforeinput at all. So neither the real shortcut nor execCommand can stand in
// for the user's route here. What IS deterministic is our own guard: assert the
// handler cancels the shortcut, and that the transcript stays free of formatting.
test('the transcript cancels the bold/italic/underline shortcuts', async ({ page }) => {
  const cancelled = await page.evaluate(() => {
    const ht = document.getElementById('hypertranscript');
    ht.focus();
    const fire = (key, mods) => {
      const e = new KeyboardEvent('keydown', Object.assign(
        { key, bubbles: true, cancelable: true }, mods));
      ht.dispatchEvent(e);
      return e.defaultPrevented;
    };
    return {
      metaB: fire('b', { metaKey: true }),
      metaI: fire('i', { metaKey: true }),
      metaU: fire('u', { metaKey: true }),
      ctrlB: fire('b', { ctrlKey: true }),
      // unmodified typing and unrelated shortcuts must pass through untouched
      // ('k' is bound to nothing; ⌘S is deliberately cancelled by the save
      // handler in hyperaudio-save.js, so it is no use as a control here)
      plainB: fire('b', {}),
      metaK: fire('k', { metaKey: true }),
    };
  });

  expect(cancelled.metaB).toBe(true);
  expect(cancelled.metaI).toBe(true);
  expect(cancelled.metaU).toBe(true);
  expect(cancelled.ctrlB).toBe(true);
  expect(cancelled.plainB).toBe(false);   // typing the letter b still works
  expect(cancelled.metaK).toBe(false);    // unrelated shortcuts are untouched
});

test('format* input types are refused by the transcript', async ({ page }) => {
  // the other hook: routes that raise beforeinput (menu bar, context menu)
  const result = await page.evaluate(() => {
    const ht = document.getElementById('hypertranscript');
    const send = (inputType) => {
      const e = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
      ht.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // NB: Chromium's InputEvent constructor validates inputType against a known
    // list and normalises anything else to "" — formatBackColor and
    // formatFontColor arrive empty, so they cannot be exercised this way. Only
    // constructible types are asserted here; the guard itself matches on the
    // format* prefix, so it covers the rest when a real UI raises them.
    return {
      bold: send('formatBold'),
      italic: send('formatItalic'),
      underline: send('formatUnderline'),
      strike: send('formatStrikeThrough'),
      typing: send('insertText'),                 // ordinary input must survive
      paste: send('insertFromPaste'),
    };
  });

  expect(result.bold).toBe(true);
  expect(result.italic).toBe(true);
  expect(result.underline).toBe(true);
  expect(result.strike).toBe(true);
  expect(result.typing).toBe(false);
  expect(result.paste).toBe(false);
});

test('suppressing formatting leaves typing and redaction alone', async ({ page }) => {
  await page.evaluate(() => {
    const ht = document.getElementById('hypertranscript');
    ht.focus();
    const span = ht.querySelector('span[data-m]:not(.speaker)');
    const range = document.createRange();
    range.setStart(span.firstChild, 0);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.type('TYPED');
  await expect(page.locator('#hypertranscript')).toContainText('TYPED');

  // redaction sets span.style directly and bypasses both hooks
  const struck = await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.style.textDecoration = 'line-through';
    return /line-through/.test(span.getAttribute('style') || '');
  });
  expect(struck).toBe(true);
  expect(await page.locator('#hypertranscript b, #hypertranscript i').count()).toBe(0);
});

// #511 — the caret survives the debounced sanitise pass. The nbsp walk ran
// BEFORE the caret was saved: rewriting nodeValue on the caret's own text node
// collapses the selection to a node boundary, so the save recorded the corpse
// and the restore reproduced it — after every natural typing pause the caret
// parked before the word being typed, and the next keystrokes landed there.
test('the caret stays where the user typed across the sanitise pass (#511)', async ({ page }) => {
  // caret at the end of a word span, then real typing (this is what leaves
  // nbsp in the node — the trigger)
  await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    t.focus();
    const span = [...t.querySelectorAll('span[data-m]')].find((s) => s.textContent.trim() === 'makes');
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(span.firstChild, span.firstChild.nodeValue.length);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  });
  await page.keyboard.type('scooby dooby doo ');
  await page.waitForTimeout(1600); // past the debounced sanitise (splits fire)

  const r = await page.evaluate(() => {
    const sel = window.getSelection();
    return {
      // the caret must sit at the end of the last typed word, inside its span
      anchorText: sel.anchorNode && sel.anchorNode.nodeValue,
      atEnd: sel.anchorNode && sel.anchorOffset === sel.anchorNode.nodeValue.length,
      spans: [...document.querySelectorAll('#hypertranscript span[data-m]')]
        .map((s) => s.textContent.trim()).filter((t) => /^(scooby|dooby|doo)$/.test(t)),
    };
  });
  expect(r.spans).toEqual(['scooby', 'dooby', 'doo']); // the split still works
  expect(r.anchorText).toBe('doo ');
  expect(r.atEnd).toBe(true);
});

test('the caret survives a pass where only the nbsp rewrite fires (#511)', async ({ page }) => {
  // one word, no internal space: no split/merge/reflow — the old restore
  // condition skipped this case entirely, so the nbsp rewrite alone lost the
  // caret with nothing to put it back
  await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    t.focus();
    const span = [...t.querySelectorAll('span[data-m]')].find((s) => s.textContent.trim() === 'makes');
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(span.firstChild, 2);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  });
  await page.keyboard.type('X');
  // force an nbsp into the caret's node the way contenteditable does
  await page.evaluate(() => {
    const sel = window.getSelection();
    const node = sel.anchorNode;
    const offset = sel.anchorOffset;
    node.nodeValue = node.nodeValue.replace(/^ma/, 'ma '.slice(0, 2)) // no-op guard
      || node.nodeValue;
    // put a real nbsp after the caret so the walk must rewrite THIS node
    node.nodeValue = node.nodeValue.slice(0, offset) + ' ' + node.nodeValue.slice(offset + 1);
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  });
  await page.keyboard.press('Shift'); // a keyup to reset the sanitise timer
  await page.waitForTimeout(1600);

  const r = await page.evaluate(() => {
    const sel = window.getSelection();
    return { anchorText: sel.anchorNode && sel.anchorNode.nodeValue, offset: sel.anchorOffset };
  });
  expect(r.anchorText).toContain('maX'); // still in the edited word's node
  expect(r.offset).toBe(3); // right after the typed X
});

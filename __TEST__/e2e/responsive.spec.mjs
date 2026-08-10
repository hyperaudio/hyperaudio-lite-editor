// The phone layout (#349/#375): pinned player, Recents drawer, and the
// audio-only collapse. Runs at 390×844.
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

const rect = (page, sel) => page.evaluate((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}, sel);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('single-column stack with no horizontal overflow', async ({ page }) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const navbar = await rect(page, '.main-panel');
  const player = await rect(page, '#player-pane');
  const transcript = await rect(page, '.transcript-holder');
  const playbar = await rect(page, '#playbar');
  expect(player.y).toBeGreaterThanOrEqual(navbar.h - 1);
  expect(transcript.y).toBeGreaterThanOrEqual(player.y + player.h - 2);
  expect(playbar.y).toBeGreaterThan(transcript.y);
});

test('Recents drawer slides in via the sidebar toggle and closes on backdrop', async ({ page }) => {
  expect((await rect(page, '#recents-pane')).x).toBeLessThan(0); // off-canvas
  await page.click('#sidebar-toggle');
  await page.waitForTimeout(350);
  expect((await rect(page, '#recents-pane')).x).toBeGreaterThanOrEqual(0);
  await page.mouse.click(375, 422); // exposed backdrop right of the 320px drawer
  await page.waitForTimeout(350);
  expect((await rect(page, '#recents-pane')).x).toBeLessThan(0);
});

// The two corner buttons are position:fixed over the card, so nothing in the
// layout reserves room for them — only .hyperaudio-transcript's top padding
// does. Below 948px the padding shorthand had reset that to 8px while the
// buttons stayed at holder-top + 10px, and the first line ran underneath both.
//
// Each band computes the buttons' `top` as its own literal, from a different
// stack of offsets (nav height, holder padding, the transcript's own top), so
// they drift apart silently. The rule that holds across all of them: a button
// sits on the transcript element's top edge, and the 48px padding is what
// keeps the text clear of it. The widths below straddle every breakpoint.
test('the corner buttons never sit on the first line of transcript text', async ({ page }) => {
  for (const width of [390, 780, 940, 1000, 1200]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(350); // the holder's 0.25s top transition
    const boxes = await page.evaluate(() => {
      // NOT offsetParent: it is null for every position:fixed element, which
      // both corner buttons are — that check silently skipped them entirely.
      const box = (s) => {
        const el = document.querySelector(s);
        if (el === null) return null;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      return {
        info: box('#transcript-info-btn'),
        copy: box('#transcript-copy-btn'),
        word: box('#hypertranscript [data-m]'),
        transcript: box('#hypertranscript'),
      };
    });
    expect(boxes.word, `first word missing at ${width}px`).not.toBeNull();
    for (const name of ['info', 'copy']) {
      const btn = boxes[name];
      if (btn === null) continue; // hidden at this width is fine; overlapping is not
      const clears = btn.bottom <= boxes.word.top
        || btn.right <= boxes.word.left
        || btn.left >= boxes.word.right;
      expect(clears, `${name} button overlaps the first word at ${width}px`).toBe(true);
      // and rides the text column's top edge rather than floating above it
      expect(Math.abs(btn.top - boxes.transcript.top),
        `${name} button is off the transcript's top edge at ${width}px`).toBeLessThanOrEqual(4);
    }
  }
});

test('audio-only collapses the pinned player to the controls strip', async ({ page }) => {
  const before = (await rect(page, '.transcript-holder')).y;
  await page.click('#audio-only-btn');
  await page.waitForTimeout(400);
  expect((await rect(page, '#player-pane')).h).toBeLessThan(60);
  expect((await rect(page, '.transcript-holder')).y).toBeLessThan(before);
  expect(await page.evaluate(() => document.body.classList.contains('video-collapsed'))).toBe(true);
});

// The undo/redo corner float (#400): touch-only, riding the transcript card's
// top edge like ⓘ/copy. The default test context is a fine-pointer device, so
// here they must be hidden regardless of viewport width.
test('undo/redo buttons are hidden on fine-pointer devices', async ({ page }) => {
  await expect(page.locator('#transcript-undo')).toBeHidden();
  await expect(page.locator('#transcript-redo')).toBeHidden();
});

test.describe('touch devices', () => {
  test.use({ isMobile: true, hasTouch: true });

  test('undo/redo float on the card edge, clear of the copy button and the text', async ({ page }) => {
    // Since #524 a button with nothing to do is hidden, so earn both first:
    // an edit makes undo available, undoing it makes redo available.
    await page.evaluate(() => {
      const t = document.querySelector('#hypertranscript');
      t.focus();
      const span = t.querySelector('span[data-m]');
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(span.firstChild, 1);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.type('X');
    await page.waitForTimeout(1700); // fold boundary: the next run is its own entry
    await page.keyboard.type('Y');
    await page.click('#transcript-undo'); // one entry back: both directions live
    const boxes = await page.evaluate(() => {
      const box = (s) => {
        const el = document.querySelector(s);
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      return {
        undo: box('#transcript-undo'),
        redo: box('#transcript-redo'),
        copy: box('#transcript-copy-btn'),
        word: box('#hypertranscript [data-m]'),
        transcript: box('#hypertranscript'),
      };
    });
    expect(boxes.undo).not.toBeNull();
    expect(boxes.redo).not.toBeNull();
    // riding the same top edge as the rest of the corner family
    for (const name of ['undo', 'redo']) {
      expect(Math.abs(boxes[name].top - boxes.transcript.top),
        `${name} off the transcript's top edge`).toBeLessThanOrEqual(4);
      expect(boxes[name].bottom, `${name} overlaps the first line`).toBeLessThanOrEqual(boxes.word.top);
    }
    // ↶ ↷ 📋 in a row, no overlaps
    expect(boxes.undo.right).toBeLessThanOrEqual(boxes.redo.left);
    if (boxes.copy !== null) expect(boxes.redo.right).toBeLessThanOrEqual(boxes.copy.left);
  });

  // #524 — a disabled button earns no corner space: it disappears rather than
  // greying. Slots stay fixed — a slid-in neighbour would land under the
  // finger mid-undo-run; a vanished button leaves the finger over nothing.
  test('only actionable undo/redo buttons occupy the corner (#524)', async ({ page }) => {
    const undo = page.locator('#transcript-undo');
    const redo = page.locator('#transcript-redo');
    // a fresh page has nothing to undo or redo: a clean two-button corner
    await expect(undo).toBeHidden();
    await expect(redo).toBeHidden();

    await page.evaluate(() => {
      const t = document.querySelector('#hypertranscript');
      t.focus();
      const span = t.querySelector('span[data-m]');
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(span.firstChild, 1);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.type('X');
    await expect(undo).toBeVisible();  // something to undo now
    await expect(redo).toBeHidden();   // still nothing to redo

    await page.click('#transcript-undo');
    await expect(redo).toBeVisible();  // the undo made redo actionable
    const redoSlot = await redo.boundingBox();

    // undo history exhausted: ↶ vanishes, ↷ HOLDS ITS SLOT (no sliding)
    await expect(undo).toBeHidden({ timeout: 6000 });
    const redoSlotAfter = await redo.boundingBox();
    expect(Math.abs(redoSlotAfter.x - redoSlot.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(redoSlotAfter.y - redoSlot.y)).toBeLessThanOrEqual(1);

    // and redoing brings ↶ back while ↷ empties and vanishes
    await page.click('#transcript-redo');
    await expect(undo).toBeVisible();
    await expect(redo).toBeHidden();
  });
});

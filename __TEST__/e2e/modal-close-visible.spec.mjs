// #660 — a modal taller than the viewport scrolls inside its box, and the ✕
// at its top-right corner scrolled away with the content. It is pinned to the
// box's scrollport now: wherever the box is scrolled to, the ✕ is on screen.
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 420 } });   // short: every long modal scrolls

const closeInView = (page) => page.evaluate(() => {
  const box = document.querySelector('.modal-toggle:checked + .modal .modal-box');
  if (box === null) return null;
  box.scrollTop = box.scrollHeight;               // as far down as it goes
  const close = box.querySelector('.btn-circle[aria-label="Close"]');
  if (close === null) return { hasClose: false };
  const b = box.getBoundingClientRect();
  const c = close.getBoundingClientRect();
  // in the box's own units: the box scales in as it opens, and WebKit can
  // leave one modal mid-scale for a programmatic toggle, which is not the
  // question here
  const scale = b.width / box.offsetWidth;
  const fromRight = (b.right - c.right) / scale;
  const fromTop = (c.top - b.top) / scale;
  return {
    hasClose: true,
    scrolls: box.scrollHeight > box.clientHeight + 1,
    scrolled: box.scrollTop,
    inView: c.top >= b.top - 1 && c.bottom <= b.bottom + 1 && c.right <= b.right + 1,
    // still where it always was: 0.5rem in from the box's top-right corner
    atCorner: Math.abs(fromRight - 8) <= 2 && Math.abs(fromTop - 8) <= 2,
  };
});

test('every modal keeps its ✕ in view however far it is scrolled (#660)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // every modal a user can open: the retired captions modal keeps its markup
  // behind content-visibility: hidden and no label, and is not laid out
  const toggles = await page.evaluate(() =>
    [...document.querySelectorAll('input.modal-toggle')]
      .filter((t) => t.id !== '' && t.nextElementSibling !== null && t.nextElementSibling.style.contentVisibility !== 'hidden')
      .map((t) => t.id));
  expect(toggles.length).toBeGreaterThan(5);

  const results = {};
  for (const id of toggles) {
    await page.evaluate((id) => {
      const t = document.getElementById(id);
      t.checked = true; t.dispatchEvent(new Event('change'));
    }, id);
    await page.waitForTimeout(300);                 // the box's 0.2s open transition
    results[id] = await closeInView(page);
    await page.evaluate((id) => {
      const t = document.getElementById(id);
      t.checked = false; t.dispatchEvent(new Event('change'));
    }, id);
  }
  const failures = Object.entries(results)
    .filter(([, r]) => r !== null && r.hasClose && !(r.inView && r.atCorner))
    .map(([id, r]) => `${id}: ${JSON.stringify(r)}`);
  expect(failures).toEqual([]);
  // and the check meant something: at this height at least one modal scrolled
  expect(Object.values(results).some((r) => r !== null && r.scrolls && r.scrolled > 0)).toBe(true);
});

test('the project dialog and the export modal keep theirs too (#660)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // the dialog chassis every notice rides, with a message long enough to scroll
  await page.evaluate(() => {
    window.HyperaudioSave.dialog(Array(40).fill('A long line of explanation that goes on.').join('\n\n'), { title: 'Long', cancelButton: false });
  });
  await page.waitForSelector('#project-dialog.modal-open');
  const r = await page.evaluate(() => {
    const box = document.querySelector('#project-dialog .modal-box');
    box.scrollTop = box.scrollHeight;
    const c = box.querySelector('.btn-circle[aria-label="Close"]').getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return { scrolls: box.scrollHeight > box.clientHeight + 1, inView: c.top >= b.top - 1 && c.bottom <= b.bottom + 1 };
  });
  expect(r).toEqual({ scrolls: true, inView: true });
  await page.click('#project-dialog-close');
  await expect(page.locator('#project-dialog.modal-open')).toHaveCount(0);
});

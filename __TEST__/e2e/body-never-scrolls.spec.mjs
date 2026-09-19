// #632 — the whole page moved up 18px and stuck, fixed navbar included.
// While a modal is open daisyUI puts overflow:hidden on the root; that stops
// the body's own overflow propagating to the viewport, so the body becomes a
// scroll container with the ~18px of bleed #354 noted, and WebKit never
// revokes that once the root is visible again. The next scrollIntoView (a
// project open restoring its scroll anchor) spent the 18px, and overflow:hidden
// draws no scrollbar to undo it. The body is now overflow:clip — a box that is
// never a scroll container — and this pins that contract in both engines.
//
// Playwright's WebKit does not apply daisyUI's :root:has() modal rule, so the
// root is forced to overflow:hidden here directly: the state a modal leaves.
import { test, expect, webkit } from '@playwright/test';

const probe = (page) => page.evaluate(async () => {
  const out = { bodyOverflow: getComputedStyle(document.body).overflowY };
  document.documentElement.style.overflow = 'hidden';        // what an open modal does
  await new Promise((r) => setTimeout(r, 100));
  document.body.scrollTop = 5;
  out.settableWhileRootHidden = document.body.scrollTop;
  document.body.scrollTop = 0;
  document.documentElement.style.overflow = '';              // modal closed
  await new Promise((r) => setTimeout(r, 100));
  document.body.scrollTop = 5;
  out.settableAfter = document.body.scrollTop;
  document.body.scrollTop = 0;
  const navBefore = document.querySelector('.main-panel').getBoundingClientRect().top;
  const spans = document.querySelectorAll('#hypertranscript span[data-m]');
  spans[Math.min(spans.length - 1, 120)].scrollIntoView({ block: 'start' });   // the anchor restore
  await new Promise((r) => setTimeout(r, 200));
  out.bodyScrollTopAfterReveal = document.body.scrollTop;
  out.navbarMoved = document.querySelector('.main-panel').getBoundingClientRect().top - navBefore;
  return out;
});

const expectNeverScrolls = (r) => {
  expect(r.bodyOverflow).toBe('clip');
  expect(r.settableWhileRootHidden, 'the body took a scrollTop while the root was overflow:hidden').toBe(0);
  expect(r.settableAfter).toBe(0);
  expect(r.bodyScrollTopAfterReveal, 'scrollIntoView scrolled the body').toBe(0);
  expect(r.navbarMoved).toBe(0);
};

test('the body is never a scroll container, modal or not (#632)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  expectNeverScrolls(await probe(page));
});

test('WebKit: the body is never a scroll container, modal or not (#632)', async () => {
  let browser;
  try {
    browser = await webkit.launch();
  } catch (e) {
    test.skip(true, 'WebKit build not installed: ' + e.message);
    return;
  }
  try {
    const page = await (await browser.newContext({ viewport: { width: 1336, height: 879 } })).newPage();
    await page.goto('http://localhost:4173/index.html');
    await page.waitForSelector('#hypertranscript [data-m]');
    expectNeverScrolls(await probe(page));
  } finally {
    await browser.close();
  }
});

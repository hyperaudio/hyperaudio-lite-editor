// #575 is a WebKit-only bug, invisible to the rest of the suite: removing the
// player's poster (and epsilon-seeking) moved the element into a display mode
// WebKit never leaves, so every project opened after a video one painted
// NOTHING — while the DOM said all was well, poster attribute present and
// resolving. Nothing observable from JS distinguishes the two states, so this
// screenshots the element and asks whether any picture is there.
//
// Launches WebKit itself: the suite's default project is Chromium, where this
// bug does not reproduce at all.
import { test, expect, webkit } from '@playwright/test';
import { pngLuma } from './png-luma.mjs';

const FIXTURE = 'http://localhost:4173/__TEST__/e2e/fixtures/first-frame-posters.html';

test('WebKit: a project opened after a video still paints its poster (#575)', async () => {
  let browser;
  try {
    browser = await webkit.launch();
  } catch (e) {
    test.skip(true, 'WebKit build not installed: ' + e.message);
    return;
  }
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(FIXTURE);
    await page.evaluate(() => window.ready); // the fixture drives both elements

    const alone = pngLuma(await page.locator('#first').screenshot());
    const afterVideo = pngLuma(await page.locator('#hyperplayer').screenshot());

    // the control: audio on its own has always painted its poster
    expect(alone.distinctLuma).toBeGreaterThan(20);

    // the bug: one distinct luminance value across the whole box — the
    // element painting nothing, the page background showing through
    expect(
      afterVideo.distinctLuma,
      'audio after a video painted a uniform box: the WebKit display-mode trap',
    ).toBeGreaterThan(20);

    // and both elements agree, as their identical DOM state says they should
    expect(Math.abs(afterVideo.distinctLuma - alone.distinctLuma)).toBeLessThan(60);
  } finally {
    await browser.close();
  }
});

test('the poster is never removed, in any engine (#575)', async ({ page }) => {
  // The mechanism behind the WebKit symptom, guarded everywhere: once the
  // element has been posterless it cannot be recovered, so the fix is that it
  // never is.
  await page.goto(FIXTURE);
  await page.evaluate(() => {
    window.__posterGone = false;
    const el = document.getElementById('hyperplayer');
    new MutationObserver(() => {
      if (el.getAttribute('poster') === null) window.__posterGone = true;
    }).observe(el, { attributes: true, attributeFilter: ['poster'] });
  });
  await page.evaluate(() => window.ready);
  expect(await page.evaluate(() => window.__posterGone)).toBe(false);
  expect(await page.getAttribute('#hyperplayer', 'poster')).not.toBe(null);
});

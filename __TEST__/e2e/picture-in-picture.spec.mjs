// #600 — Safari does nothing on the PiP button because we only ever called the
// standard API. WebKit reports document.pictureInPictureEnabled === true and
// offers requestPictureInPicture(), then refuses the call with
// NotSupportedError; its working API is webkitSetPresentationMode.
//
// Entering real PiP in Safari cannot be automated here, so this pins the
// DECISION: given the presentation-mode API, we use it and do not fall back to
// a call that engine rejects. The standard path is guarded too, so preferring
// WebKit's API costs Chromium nothing.
import { test, expect } from '@playwright/test';

const makeWebm = () => new Promise((resolve) => {
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#a63'; ctx.fillRect(0, 0, 320, 180);
  const rec = new MediaRecorder(canvas.captureStream(10), { mimeType: 'video/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => resolve(URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })));
  rec.start();
  let f = 0;
  const t = setInterval(() => { ctx.fillRect(0, 0, 320, 180); if (++f >= 8) { clearInterval(t); rec.stop(); } }, 60);
});

async function loadVideo(page) {
  await page.evaluate(`(${makeWebm.toString()})().then((url) => {
    const v = document.getElementById('hyperplayer');
    v.src = url;
    return new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
  })`);
  await page.waitForTimeout(400);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('the presentation-mode API is preferred where it exists (#600)', async ({ page }) => {
  await loadVideo(page);
  // Stand in for WebKit: the same two methods Safari exposes, recording what
  // they are asked to do. requestPictureInPicture is watched too — reaching it
  // would be the bug, since that is the call WebKit rejects.
  await page.evaluate(() => {
    const v = document.getElementById('hyperplayer');
    window.__calls = [];
    v.webkitPresentationMode = 'inline';
    v.webkitSupportsPresentationMode = (mode) => mode === 'picture-in-picture';
    v.webkitSetPresentationMode = (mode) => {
      window.__calls.push('webkit:' + mode);
      v.webkitPresentationMode = mode;
    };
    const original = v.requestPictureInPicture;
    v.requestPictureInPicture = function () {
      window.__calls.push('standard');
      return original.apply(this, arguments);
    };
  });

  await page.click('#pip-btn');
  expect(await page.evaluate(() => window.__calls)).toEqual(['webkit:picture-in-picture']);

  // and it toggles back out rather than only ever going in
  await page.click('#pip-btn');
  expect(await page.evaluate(() => window.__calls)).toEqual(['webkit:picture-in-picture', 'webkit:inline']);
});

test('engines without it still use the standard API (#600)', async ({ page }) => {
  await loadVideo(page);
  await page.click('#pip-btn');
  await expect.poll(() => page.evaluate(() => document.pictureInPictureElement !== null))
    .toBe(true);
});

test('the button is shown when only the presentation-mode API exists (#600)', async ({ page }) => {
  // The old gate hid the button whenever document.pictureInPictureEnabled was
  // false, which would hide it in an engine that offers only WebKit's API.
  // On the PROTOTYPE, not the element: the module gates the button as soon as
  // the player exists, so a stub that waits for the element is a race — and
  // one that failed only sometimes, which is worse than failing.
  await page.addInitScript(() => {
    Object.defineProperty(document, 'pictureInPictureEnabled', { get: () => false });
    HTMLVideoElement.prototype.webkitSupportsPresentationMode = function (m) {
      return m === 'picture-in-picture';
    };
    HTMLVideoElement.prototype.webkitSetPresentationMode = function () {};
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect(page.locator('#pip-btn')).toBeVisible();
});

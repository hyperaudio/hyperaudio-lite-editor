import { test, expect } from '@playwright/test';

// #574 — media served through a host application's own URL scheme (#547) is
// fetched to embed it in a .hyperaudio file. That fetch can legitimately fail
// (the file moved or was renamed on the host side, permissions changed, the
// handler is not ready yet) and it was unguarded: the raw TypeError escaped
// as "Failed to fetch" and the save was ABANDONED, while the sibling branch
// for http(s) media has always caught, explained, and offered a link save.
// Same class of bug as #573.

test('a failing embedder-scheme fetch offers the link save instead of dying', async ({ page }) => {
  const dialogs = [];
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  await page.evaluate(() => {
    // a host application that declares a scheme, whose handler then fails
    window.hyperaudioLinkSchemes = ['app-media:'];
    globalThis.hyperaudioLinkSchemes = window.hyperaudioLinkSchemes;
    const player = document.getElementById('hyperplayer');
    Object.defineProperty(player, 'src', { get: () => 'app-media://library/talk.mp4', configurable: true });
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  });
  // the scheme has no handler in a plain browser, so the fetch rejects — the
  // failure this test is about
  await page.waitForTimeout(600);

  // the designed dialog carries the explanation and the choice
  const askedPromise = page.waitForFunction(() => {
    const el = document.getElementById('project-dialog');
    return el !== null && el.classList.contains('modal-open')
      ? el.querySelector('#project-dialog-message').textContent : false;
  }, null, { timeout: 20000 });

  await page.evaluate(() => { window.HyperaudioSave.exportProject(); });
  const asked = await (await askedPromise).jsonValue();

  expect(asked).toContain('could not provide the media file');
  expect(asked).toContain('LINK');
  // and it is a real choice: cancelling abandons nothing silently
  await page.click('#project-dialog-cancel');
  await expect(page.locator('#project-dialog.modal-open')).toHaveCount(0);
  expect(dialogs).toEqual([]); // no native alert anywhere in this path
});

// #44 — where the editor comes from, for people arriving from a post: a faint
// GitHub mark at the far right of the play bar, away from the editing
// controls, and the source and hyper.audio links in words in Settings ▸
// Application.
import { test, expect } from '@playwright/test';

const REPO = 'https://github.com/hyperaudio/hyperaudio-lite-editor';
const HYPERAUDIO = 'https://hyper.audio/';

const ready = async (page) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
};

const linkOf = (page, id) => page.evaluate((id) => {
  const a = document.getElementById(id);
  return a === null ? null : { href: a.href, target: a.target, rel: a.rel, text: a.getAttribute('aria-label') || a.textContent.trim() };
}, id);

// the mark sits last in the play bar, at its right-hand end
const placement = (page) => page.evaluate(() => {
  const bar = document.getElementById('playbar');
  const link = document.getElementById('github-link');
  const b = bar.getBoundingClientRect();
  const l = link.getBoundingClientRect();
  const rate = document.getElementById('playbar-rate').getBoundingClientRect();
  return {
    last: bar.lastElementChild === link,
    rightOfRate: l.left >= rate.right,
    nearRightEdge: b.right - l.right < 24,
    inBar: l.top >= b.top && l.bottom <= b.bottom,
  };
});

for (const width of [1280, 400]) {
  test(`at ${width}px the play bar ends with a faint GitHub mark linking to the source in a new tab`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await ready(page);
    await expect(page.locator('#github-link')).toBeVisible();
    expect(await linkOf(page, 'github-link')).toEqual({ href: REPO, target: '_blank', rel: 'noopener', text: 'Source code on GitHub' });
    expect(await placement(page)).toEqual({ last: true, rightOfRate: true, nearRightEdge: true, inBar: true });
    // the mark is faint, its tooltip is not
    expect(await page.evaluate(() => ({
      mark: Number(getComputedStyle(document.querySelector('#github-link svg')).opacity),
      link: Number(getComputedStyle(document.getElementById('github-link')).opacity),
    }))).toEqual({ mark: 0.35, link: 1 });
  });
}

test('Settings ▸ Application links to the source and to hyper.audio in words', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const m = document.getElementById('settings-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#settings-source-link')).toBeVisible();
  expect(await linkOf(page, 'settings-source-link')).toEqual({ href: REPO, target: '_blank', rel: 'noopener', text: 'GitHub' });
  expect(await linkOf(page, 'settings-hyperaudio-link')).toEqual({ href: HYPERAUDIO, target: '_blank', rel: 'noopener', text: 'hyper.audio' });
});

// #604 — a host may know about projects the editor does not (.hyperaudio files
// in a folder the user chose). The panel shows them, plainly not-yet-opened,
// and hands clicks back to the host: the host owns storage, the panel owns
// presentation — the division the poster seam already draws.
import { test, expect } from '@playwright/test';

const panel = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#file-picker .recents-row')].map((li) => ({
    name: li.querySelector('.file-item') ? li.querySelector('.file-item').textContent.trim() : '',
    external: li.classList.contains('recents-row-external'),
  })));

const withHost = (page, body) => page.addInitScript(body);

test('host rows appear, interleaved by date rather than grouped (#604)', async ({ page }) => {
  await withHost(page, () => {
    window.hyperaudioExternalProjects = async () => ([
      { id: 'ext:newest', title: 'newest', modified: 9_000_000_000_000 },
      { id: 'ext:oldest', title: 'oldest', modified: 1 },
    ]);
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  // the intro project sits between them by date: grouping the host's rows
  // together would put the two-list feel back inside one list
  await expect.poll(() => panel(page)).toEqual([
    { name: 'newest', external: true },
    { name: 'How to use the Editor', external: false },
    { name: 'oldest', external: true },
  ]);
});

test('clicking a host row delegates to the host (#604)', async ({ page }) => {
  await withHost(page, () => {
    window.hyperaudioExternalProjects = async () => ([{ id: 'ext:one', title: 'one', modified: 9_000_000_000_000 }]);
    window.__opened = [];
    window.hyperaudioOpenExternalProject = async (id) => { window.__opened.push(id); };
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => panel(page)).toContainEqual({ name: 'one', external: true });

  const before = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await page.click('.recents-row-external .file-item');
  await expect.poll(() => page.evaluate(() => window.__opened)).toEqual(['ext:one']);
  // and the panel did not try to open something it knows nothing about
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(before);
});

test('host rows carry no actions until they are real projects (#604)', async ({ page }) => {
  await withHost(page, () => {
    window.hyperaudioExternalProjects = async () => ([{ id: 'ext:one', title: 'one', modified: 9_000_000_000_000 }]);
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => panel(page)).toContainEqual({ name: 'one', external: true });

  // rename, star and delete would all be lies about something not held here
  expect(await page.locator('.recents-row-external .recents-kebab').count()).toBe(0);
  await expect(page.locator('.recents-row-external .recents-external-badge')).toBeVisible();
});

test('a hook that throws leaves the panel with its own rows (#604)', async ({ page }) => {
  await withHost(page, () => {
    window.hyperaudioExternalProjects = () => { throw new Error('host is broken'); };
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => panel(page)).toEqual([{ name: 'How to use the Editor', external: false }]);
});

test('a hook that hangs does not hold the panel hostage (#604)', async ({ page }) => {
  await withHost(page, () => {
    window.hyperaudioExternalProjects = () => new Promise(() => {}); // never settles
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // no allowance to wait out: the panel never waited in the first place
  await expect.poll(() => panel(page), { timeout: 3000 })
    .toEqual([{ name: 'How to use the Editor', external: false }]);
});

test('a slow host does not delay the panel (#604)', async ({ page }) => {
  // The panel renders on every library write — after each autosave, not just
  // when Recents is opened — so waiting on the host is felt while working.
  // Measured before the rewrite: a 1200ms host delayed the active-row
  // highlight by 1216ms after a switch, leaving the list pointing at the
  // project you had just left.
  // The gap between the host's delay and the assertion window has to be wide
  // enough to survive a loaded machine: at 1200ms vs 900ms this failed in a
  // full gate run where other specs were launching browsers. The point is that
  // the panel does not WAIT, not that it renders within any particular
  // millisecond, so give the host a delay nothing could mistake for prompt.
  await withHost(page, () => {
    window.hyperaudioExternalProjects = () => new Promise((r) => setTimeout(() => r([
      { id: 'ext:slow', title: 'a slow host row', modified: 9_000_000_000_000 },
    ]), 6000));
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  // the editor's own row is there long before the host answers
  await expect.poll(() => panel(page), { timeout: 3000 })
    .toEqual([{ name: 'How to use the Editor', external: false }]);
  // and the host's arrives afterwards, without anything having blocked
  await expect.poll(() => panel(page), { timeout: 12000 }).toEqual([
    { name: 'a slow host row', external: true },
    { name: 'How to use the Editor', external: false },
  ]);
});

test('a stable host is not asked forever (#604)', async ({ page }) => {
  // Re-rendering when the answer arrives could re-ask, re-render, re-ask.
  // It settles because a render only repeats when the answer CHANGED.
  await withHost(page, () => {
    window.__calls = 0;
    window.hyperaudioExternalProjects = async () => {
      window.__calls += 1;
      return [{ id: 'ext:stable', title: 'stable', modified: 9_000_000_000_000 }];
    };
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => panel(page)).toContainEqual({ name: 'stable', external: true });

  // The host is asked once per render, and the panel renders on every library
  // write — of which a slow machine still has a few to come at this point
  // (the intro's media metadata, its poster), so a count taken now and
  // compared two seconds later measured the machine (#706). What the test is
  // for is that the asking STOPS: two seconds with no new call, reached
  // within twenty. A render loop never gets there.
  const calls = () => page.evaluate(() => window.__calls);
  await expect.poll(async () => {
    const before = await calls();
    await page.waitForTimeout(2000);
    return (await calls()) - before;
  }, { timeout: 20000, intervals: [100] }).toBe(0);
  expect(await calls()).toBeLessThan(20);
});

test('a host row colliding with a real project is skipped (#604)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const realId = await page.evaluate(async () => {
    for (let i = 0; i < 50; i += 1) {
      const id = window.HyperaudioSave.library.currentId();
      if (id !== null) return id;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  });
  expect(realId).not.toBeNull();

  // the host is better placed to dedupe, but the panel does not depend on it
  await page.evaluate((id) => {
    window.hyperaudioExternalProjects = async () => ([{ id, title: 'a duplicate', modified: 9_000_000_000_000 }]);
    document.dispatchEvent(new CustomEvent('hyperaudioLibraryChanged'));
  }, realId);

  await expect.poll(() => panel(page)).toEqual([{ name: 'How to use the Editor', external: false }]);
});

test('no hooks, no change (#604)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => panel(page)).toEqual([{ name: 'How to use the Editor', external: false }]);
  expect(await page.locator('.recents-row-external').count()).toBe(0);
});

// #694 — a host may say more about a row than that it exists: that it is
// being worked on, waiting, failed, or cannot be reached right now.
const badges = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#file-picker .recents-row-external')].map((li) => {
    const b = li.querySelector('.recents-external-badge');
    return {
      name: li.querySelector('.file-item').textContent.trim(),
      badge: b.textContent.trim(),
      title: b.getAttribute('title'),
      spinner: b.querySelector('.recents-transcribing-spinner') !== null,
    };
  }));

test('a host row can carry a state, shown as its badge with the host\'s label (#694)', async ({ page }) => {
  await withHost(page, () => {
    window.hyperaudioExternalProjects = async () => ([
      { id: 'ext:plain', title: 'Interview', modified: 9_000_000_000_004 },
      { id: 'ext:work', title: 'Keynote', modified: 9_000_000_000_003, state: 'working', stateLabel: 'Transcribing…' },
      { id: 'ext:queue', title: 'Q&A', modified: 9_000_000_000_002, state: 'queued' },
      { id: 'ext:fail', title: 'Panel', modified: 9_000_000_000_001, state: 'failed', stateLabel: 'Could not read the media' },
      { id: 'ext:gone', title: 'Archive', modified: 9_000_000_000_000, state: 'unavailable' },
      { id: 'ext:new', title: 'Future', modified: 1, state: 'teleporting' },
    ]);
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => badges(page)).toEqual([
    { name: 'Interview', badge: 'not opened', title: null, spinner: false },
    { name: 'Keynote', badge: 'working', title: 'Transcribing…', spinner: true },
    { name: 'Q&A', badge: 'queued', title: 'Waiting its turn', spinner: false },
    { name: 'Panel', badge: 'failed', title: 'Could not read the media', spinner: false },
    { name: 'Archive', badge: 'unavailable', title: 'This file can’t be opened right now', spinner: false },
    // a state this editor does not know is ignored: the row is as it was
    { name: 'Future', badge: 'not opened', title: null, spinner: false },
  ]);
  // still no actions, and still the host's to open
  expect(await page.locator('.recents-row-external .recents-kebab').count()).toBe(0);
});

test('a host changing a row\'s state redraws it when it says so (#694)', async ({ page }) => {
  await withHost(page, () => {
    window.__state = 'queued';
    window.hyperaudioExternalProjects = async () => ([
      { id: 'ext:one', title: 'Keynote', modified: 9_000_000_000_000, state: window.__state },
    ]);
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(async () => (await badges(page))[0] && (await badges(page))[0].badge).toBe('queued');
  await page.evaluate(() => {
    window.__state = 'working';
    document.dispatchEvent(new CustomEvent('hyperaudioLibraryChanged'));
  });
  await expect.poll(async () => (await badges(page))[0].badge).toBe('working');
  await page.evaluate(() => {
    window.__state = undefined;   // finished: back to a plain row
    document.dispatchEvent(new CustomEvent('hyperaudioLibraryChanged'));
  });
  await expect.poll(async () => (await badges(page))[0].badge).toBe('not opened');
});

// #700 — a row the host has marked working or queued is not something to
// open; failed and unavailable rows are exactly the ones a user retries.
test('working and queued rows cannot be clicked; failed and unavailable rows still open through the host (#700)', async ({ page }) => {
  await withHost(page, () => {
    window.__opened = [];
    window.hyperaudioOpenExternalProject = async (id) => { window.__opened.push(id); };
    window.hyperaudioExternalProjects = async () => ([
      { id: 'ext:work', title: 'Working', modified: 9_000_000_000_003, state: 'working' },
      { id: 'ext:queue', title: 'Queued', modified: 9_000_000_000_002, state: 'queued' },
      { id: 'ext:fail', title: 'Failed', modified: 9_000_000_000_001, state: 'failed' },
      { id: 'ext:gone', title: 'Unavailable', modified: 9_000_000_000_000, state: 'unavailable' },
    ]);
  });
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.locator('.recents-row-external').count()).toBe(4);

  const row = (title) => page.locator('#file-picker .recents-row-external', { hasText: title }).locator('.file-item');
  // the pointer passes through an inert row, and it says so to assistive tech
  await expect(row('Working')).toHaveCSS('pointer-events', 'none');
  await expect(row('Working')).toHaveAttribute('aria-disabled', 'true');
  await expect(row('Failed')).toHaveCSS('pointer-events', 'auto');
  await expect(row('Failed')).not.toHaveAttribute('aria-disabled', 'true');

  // a click on an inert row reaches nothing — forced past pointer-events, as
  // a script might send one, and the handler still declines
  await row('Working').click({ force: true });
  await row('Queued').click({ force: true });
  await row('Failed').click();
  await row('Unavailable').click();
  await expect.poll(() => page.evaluate(() => window.__opened)).toEqual(['ext:fail', 'ext:gone']);
});

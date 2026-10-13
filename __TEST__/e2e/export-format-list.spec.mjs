// #728 — the Format list leads with what most people want and says what
// each format is for: Video then Audio, the recommended format first in
// each, descriptions rather than codec names.
import { test, expect } from '@playwright/test';

const FIXTURE = '/__TEST__/fixtures/video-640x360.mp4';

const openExport = async (page) => {
  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
  return page.evaluate(() => ({
    groups: [...document.querySelectorAll('#export-format optgroup')].map((g) => ({
      label: g.label, options: [...g.querySelectorAll('option')].map((o) => [o.value, o.textContent]),
    })),
    selected: document.getElementById('export-format').value,
  }));
};

test('a video source: Video first with MP4 leading, then Audio with MP3 leading, each format described', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate((src) => { document.getElementById('hyperplayer').src = src; }, FIXTURE);
  await page.waitForFunction(() => document.getElementById('hyperplayer').readyState >= 2);
  const list = await openExport(page);
  expect(list.groups.map((g) => g.label)).toEqual(['Video', 'Audio']);
  const video = list.groups[0].options.map((o) => o[0]);
  expect(video[0]).toMatch(/^(mp4|webm)$/); // MP4 where the browser can make one
  expect(list.selected).toBe(video[0]);
  const audio = list.groups[1].options.map((o) => o[0]);
  expect(audio[0]).toMatch(/^(mp3|m4a)$/);
  expect(audio).toContain('wav');
  for (const [, label] of [...list.groups[0].options, ...list.groups[1].options]) {
    expect(label).toMatch(/ — /);           // "MP4 — video that plays everywhere"
    expect(label).not.toMatch(/H\.264|AAC|VP9|Opus/); // what it is for, not what is inside
  }
});

test('an audio source: no Video group, and the recommended audio format is selected', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const list = await openExport(page);
  expect(list.groups.map((g) => g.label)).toEqual(['Audio']);
  expect(list.selected).toMatch(/^(mp3|m4a)$/);
});

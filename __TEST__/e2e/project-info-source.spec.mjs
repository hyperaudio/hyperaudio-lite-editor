// #744 — Project info on a project that plays from a link. "Source: remote
// URL" said the media was elsewhere but not where. An http(s) link now shows
// its URL, as a link. A link on a scheme the host declared is the host's to
// describe, through window.hyperaudioMediaInfo(entry), and without that hook
// the URL's last path segment stands in as the file's name.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { withoutIntroProject } from './helpers.mjs';

const require = createRequire(import.meta.url);
const save = require('../../js/hyperaudio-save.js');
const JSZip = require('jszip');

const HTTP_URL = 'https://media.example.com/archive/2026/town-hall-recording-of-the-autumn-meeting-with-questions.wav';
const HOST_URL = 'app-media://library/42/My%20Talk.mp4';

async function buildFixture(title, url) {
  const state = {
    generatorVersion: 'e2e',
    created: '2026-07-10T09:00:00Z',
    modified: '2026-07-10T11:30:00Z',
    media: { kind: 'link', path: null, url, filename: '', mimeType: '', durationSeconds: 2, sizeBytes: 0 },
    options: {
      gapRemoval: { enabled: false, thresholdMs: 500, bufferMs: 100 },
      updateCaptionsFromTranscript: true,
      view: { showSpeakers: true, showTimecodes: false },
    },
    texts: { title, language: 'en', summary: '', topics: [] },
    provenance: null,
    hasOriginal: false,
    transcript: {
      words: [{ start: 0.32, end: 0.84, text: 'Welcome' }, { start: 1.1, end: 1.5, text: 'all' }],
      paragraphs: [{ speaker: null, start: 0.32, end: 1.5 }],
    },
  };
  return save.zipProject({
    json: save.serializeProjectJson(save.buildProjectJson(state)),
    html: '<article><section><p><span data-m="320" data-d="520">Welcome </span><span data-m="1100" data-d="400">all </span></p></section></article>',
    media: null,
  }, JSZip, 'nodebuffer');
}

async function openLinkProject(page, testInfo, title, url) {
  const fixturePath = testInfo.outputPath(title.replace(/\s+/g, '-') + '.hyperaudio');
  fs.writeFileSync(fixturePath, await buildFixture(title, url));
  await page.evaluate(() => { document.getElementById('project-open-input').value = ''; });
  await page.setInputFiles('#project-open-input', fixturePath);
  // a link project opens behind a note that it plays from its URL
  await page.click('#project-dialog.modal-open #project-dialog-confirm');
  await expect(page.locator('#file-picker .file-item.active')).toHaveText(title);
  // the link cannot be played from here, so the player's error brings the
  // re-attach offer (#742) a moment later: declined, since the link is the
  // point of these tests
  const cancel = page.locator('#project-dialog.modal-open #project-dialog-cancel');
  try { await cancel.click({ timeout: 4000 }); } catch (e) { /* no offer for this link */ }
  await expect(page.locator('#project-dialog.modal-open')).toHaveCount(0);
}

async function openInfo(page) {
  await page.locator('#transcript-info-btn').click();
  await page.waitForFunction(() => document.getElementById('info-modal').checked);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { globalThis.hyperaudioLinkSchemes = ['app-media://']; });
  await withoutIntroProject(page);
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('an http link shows its URL, shortened in the middle, as a link to the whole', async ({ page }, testInfo) => {
  await openLinkProject(page, testInfo, 'Town hall', HTTP_URL);
  await openInfo(page);
  const media = page.locator('#project-info-media');
  await expect(media).toContainText('Source: https://media.example.com');
  await expect(media).not.toContainText('remote URL');
  const link = media.locator('a.info-link');
  await expect(link).toHaveAttribute('href', HTTP_URL);
  await expect(link).toHaveAttribute('title', HTTP_URL);
  expect((await link.textContent()).includes('…')).toBe(true);
  expect((await link.textContent()).length).toBeLessThan(HTTP_URL.length);
});

test('a host-scheme link is described by the host, through hyperaudioMediaInfo', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    window.hyperaudioMediaInfo = (entry) => Promise.resolve([
      ['File', 'My Talk.mp4'],
      ['Folder', '~/Movies/Talks'],
      ['Entry', String(entry.media.url)],
    ]);
  });
  await openLinkProject(page, testInfo, 'My Talk', HOST_URL);
  await openInfo(page);
  const media = page.locator('#project-info-media');
  await expect(media).toContainText('File: My Talk.mp4');
  await expect(media).toContainText('Folder: ~/Movies/Talks');
  await expect(media).toContainText('Entry: ' + HOST_URL);
  await expect(media).not.toContainText('remote URL');
  // the host's values are text, not markup
  expect(await media.locator('a').count()).toBe(0);
});

test('a host-scheme link with no hook reads as the file its path ends in', async ({ page }, testInfo) => {
  await openLinkProject(page, testInfo, 'My Talk', HOST_URL);
  await openInfo(page);
  const media = page.locator('#project-info-media');
  await expect(media).toContainText('File: My Talk.mp4');
  await expect(media).not.toContainText('remote URL');
});

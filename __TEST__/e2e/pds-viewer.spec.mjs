// #624 — a static viewer for a talk published to a PDS: reads the records
// with the editor's DOM-free reader, renders with hyperaudio-lite, no
// sign-in, no server. The repo is mocked from the serializer's own output.
import { test, expect } from '@playwright/test';

const DID = 'did:plc:abc123abc123abc123abc123';
const PDS = 'https://pds.example';
const SAMPLE = {
  words: [
    { start: 1.44, end: 2.0, text: 'Hello' },
    { start: 2.0, end: 2.3, text: 'café' },
    { start: 2.5, end: 3.0, text: 'world.' },
    { start: 4.0, end: 4.5, text: 'Second' },
    { start: 4.5, end: 5.0, text: 'paragraph.' },
  ],
  paragraphs: [{ start: 1.44, end: 3.0, speaker: 'Mark' }, { start: 4.0, end: 5.0 }],
};

async function mockRepo(page, media) {
  // the serializer lives in the editor page; borrow it to build the repo
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const exp = await page.evaluate(([d, did, media]) => window.transcriptJsonToIonosphere(d, { did, rkey: '3mvi355ibkkvn', createdAt: '2026-01-01T00:00:00.000Z', title: 'Viewer talk', media }), [SAMPLE, DID, media || null]);
  await page.route('https://plc.directory/*', (route) => route.fulfill({ json: { id: DID, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] } }));
  await page.route(PDS + '/xrpc/com.atproto.repo.getRecord*', (route) => {
    const u = new URL(route.request().url());
    const r = exp.records.find((x) => x.collection === u.searchParams.get('collection') && x.rkey === u.searchParams.get('rkey'));
    if (!r) return route.fulfill({ status: 400, json: { error: 'RecordNotFound', message: 'Could not locate record' } });
    route.fulfill({ json: { uri: 'at://' + DID + '/' + r.collection + '/' + r.rkey, value: r.value } });
  });
  await page.route(PDS + '/xrpc/com.atproto.repo.listRecords*', (route) => {
    const col = new URL(route.request().url()).searchParams.get('collection');
    route.fulfill({ json: { records: exp.records.filter((x) => x.collection === col).map((x) => ({ uri: 'at://' + DID + '/' + col + '/' + x.rkey, value: x.value })) } });
  });
  await page.route('https://media.example/**', (route) => route.fulfill({ status: 404 }));
  return exp.talkUri;
}

test('renders a published talk from its URI: title, speaker, words, and the linked media', async ({ page }) => {
  const talkUri = await mockRepo(page, { url: 'https://media.example/talk.mp3', mimeType: 'audio/mpeg' });
  await page.goto('/viewer/?talk=' + encodeURIComponent(talkUri));
  await expect(page.locator('#title')).toHaveText('Viewer talk');
  await expect(page.locator('#meta')).toContainText('Mark');
  await expect(page.locator('#meta')).toContainText('5 words · 2 paragraphs');
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')].map((s) => s.textContent.trim())))
    .toEqual(['Hello', 'café', 'world.', 'Second', 'paragraph.']);
  expect(await page.evaluate(() => document.querySelector('#hypertranscript span.speaker').textContent.trim())).toBe('[Mark]');
  expect(await page.evaluate(() => document.getElementById('hyperplayer').src)).toBe('https://media.example/talk.mp3');
  expect(await page.evaluate(() => document.getElementById('hyperplayer').hidden)).toBe(false);
  expect(await page.evaluate(() => !!window.viewerInstance)).toBe(true);   // hyperaudio-lite is driving the transcript
  expect(await page.evaluate(() => document.getElementById('ask').hidden)).toBe(true);
});

test('a talk with no media takes ?media=, and says so without it', async ({ page }) => {
  const talkUri = await mockRepo(page, null);
  await page.goto('/viewer/?talk=' + encodeURIComponent(talkUri));
  await expect(page.locator('#title')).toHaveText('Viewer talk');
  await expect(page.locator('#status')).toContainText('links no media');
  expect(await page.evaluate(() => document.getElementById('hyperplayer').hidden)).toBe(true);

  await page.goto('/viewer/?talk=' + encodeURIComponent(talkUri) + '&media=' + encodeURIComponent('https://media.example/given.mp4'));
  await expect(page.locator('#title')).toHaveText('Viewer talk');
  expect(await page.evaluate(() => document.getElementById('hyperplayer').src)).toBe('https://media.example/given.mp4');
});

test('with no talk it asks for one; a bad URI is reported and the form stays', async ({ page }) => {
  await mockRepo(page, null);
  await page.goto('/viewer/');
  expect(await page.evaluate(() => document.getElementById('ask').hidden)).toBe(false);
  await page.fill('#ask-uri', 'at://' + DID + '/tv.ionosphere.talk/3mvi999nothere');
  await page.click('#ask-form button');
  await expect(page.locator('#status')).toHaveText(/^Could not read that talk: /);
  expect(await page.evaluate(() => document.getElementById('ask').hidden)).toBe(false);
  expect(await page.evaluate(() => new URL(location.href).searchParams.get('talk'))).toContain('3mvi999nothere');
});

// #766 — a JSON import given a file that is not a transcript. The Hyperaudio
// JSON import painted whatever it was given, so a file with no words in it
// (a chat export, say) left a blank screen under the previous project's name,
// the player cleared. The Deepgram dialog threw inside its reader and said
// nothing. Both now refuse the file before anything on screen is touched,
// and say so above Recents.
import { test, expect } from '@playwright/test';

const file = (name, mimeType, contents) => ({ name, mimeType, buffer: Buffer.from(contents) });

// a chat export: an array of conversations, no words anywhere
const CHAT_EXPORT = JSON.stringify([{ uuid: '1', name: 'A chat', chat_messages: [{ text: 'hello', sender: 'human' }] }]);
const NO_WORDS = JSON.stringify({ sections: [{ start: 0, end: 10 }], paragraphs: [] });
const NOT_JSON = '<html><body>not json</body></html>';

const BAD_FILES = [
  ['a chat export', 'chat.json', CHAT_EXPORT],
  ['an object with no words', 'empty.json', NO_WORDS],
  ['a file that is not JSON', 'page.json', NOT_JSON],
];

const snapshot = (page) => page.evaluate(async () => ({
  words: document.querySelectorAll('#hypertranscript [data-m]').length,
  text: document.querySelector('#hypertranscript').textContent.slice(0, 60),
  player: document.getElementById('hyperplayer').getAttribute('src'),
  current: window.HyperaudioSave.library.currentId(),
  projects: (await window.HyperaudioSave.library.list()).length,
  active: document.querySelectorAll('#file-picker .file-item.active').length,
}));

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.library.currentId())).not.toBeNull();
});

for (const [what, name, contents] of BAD_FILES) {
  test(`Hyperaudio JSON: ${what} is refused and nothing changes`, async ({ page }) => {
    const before = await snapshot(page);
    expect(before.words).toBeGreaterThan(0);
    const chooser = page.waitForEvent('filechooser');
    await page.evaluate(() => document.querySelector('import-json').click());
    await (await chooser).setFiles(file(name, 'application/json', contents));

    const notice = page.locator('#recents-notice');
    await expect(notice).toContainText(name);
    await expect(notice).toContainText(/not valid JSON|not a Hyperaudio JSON transcript/);
    expect(await snapshot(page)).toEqual(before);
  });

  test(`Deepgram JSON: ${what} is refused and nothing changes`, async ({ page }) => {
    const before = await snapshot(page);
    await page.evaluate(() => { document.getElementById('file-import-deepgram-json-dialog').checked = true; });
    await page.setInputFiles('#deepgram-json', file(name, 'application/json', contents));
    await page.click('#file-import-deepgram-json');

    const notice = page.locator('#recents-notice');
    await expect(notice).toContainText(name);
    await expect(notice).toContainText(/not valid JSON|not a Deepgram JSON transcript/);
    expect(await snapshot(page)).toEqual(before);
  });
}

test('Deepgram JSON: a media file chosen beside a refused JSON stays off the player', async ({ page }) => {
  const before = await snapshot(page);
  await page.evaluate(() => { document.getElementById('file-import-deepgram-json-dialog').checked = true; });
  await page.setInputFiles('#deepgram-json-file', '__TEST__/fixtures/video-640x360.mp4');
  await page.setInputFiles('#deepgram-json', file('chat.json', 'application/json', CHAT_EXPORT));
  await page.click('#file-import-deepgram-json');
  await expect(page.locator('#recents-notice')).toContainText('not a Deepgram JSON transcript');
  expect(await snapshot(page)).toEqual(before);
});

test('Deepgram JSON: confirming with no JSON file chosen says so', async ({ page }) => {
  const before = await snapshot(page);
  await page.evaluate(() => { document.getElementById('file-import-deepgram-json-dialog').checked = true; });
  await page.click('#file-import-deepgram-json');
  await expect(page.locator('#recents-notice')).toContainText('Choose a Deepgram JSON file first');
  expect(await snapshot(page)).toEqual(before);
});

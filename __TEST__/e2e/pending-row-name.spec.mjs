// #612 — the in-progress row names what is BEING TRANSCRIBED, which is not the
// same question as what is open. The engine contract puts the transcription's
// media on the player before setTranscriptBusy(true), so the player is the
// authority; session.mediaFile still holds the OUTGOING project's file, and
// asking it first labelled a URL transcription with the previous project's
// name until the transcription progressed far enough to replace it.
import { test, expect } from '@playwright/test';

// A project born from a local file, so session.mediaFile holds ITS file.
const openLocalProject = (page, name) => page.evaluate(async (fileName) => {
  const sr = 8000, n = sr, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i += 1) dv.setInt16(44 + i * 2, Math.sin(i / 20) * 3000, true);
  const file = new File([buf], fileName, { type: 'audio/wav' });
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('hyperplayer').src = URL.createObjectURL(file);
  document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  const lib = window.HyperaudioSave.library;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const id = lib.currentId();
    if (id !== null && (await lib.list()).some((e) => e.id === id)) break;
  }
  await window.HyperaudioSave.saveProject();
}, name);

const pendingName = (page) => page.evaluate(() => {
  const lib = window.HyperaudioSave.library;
  const p = lib.pendingTranscription ? lib.pendingTranscription() : null;
  return p ? p.name : null;
});

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForTimeout(1000);
});

test('a URL transcription is named after the URL, not the open project (#612)', async ({ page }) => {
  await openLocalProject(page, 'THE-OPEN-PROJECT.wav');
  await page.evaluate(() => {
    // the engine's contract: its media goes on the player, THEN busy
    document.getElementById('hyperplayer').src = 'https://example.com/media/INCOMING-INTERVIEW.mp3';
    window.setTranscriptBusy(true);
  });
  expect(await pendingName(page)).toBe('INCOMING-INTERVIEW.mp3');
});

test('a local-file transcription is still named after the file (#612)', async ({ page }) => {
  // The reorder must not disturb this: a chosen file gives the player a blob:
  // src, which is not a link URL, so the name still comes from the session.
  await openLocalProject(page, 'PREVIOUS.wav');
  await page.evaluate(async () => {
    const file = new File([new Uint8Array(2048)], 'CHOSEN-FILE.mp3', { type: 'audio/mpeg' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('hyperplayer').src = URL.createObjectURL(file);
    await new Promise((r) => setTimeout(r, 200));
    window.setTranscriptBusy(true);
  });
  expect(await pendingName(page)).toBe('CHOSEN-FILE.mp3');
});

test('with no media at all the row falls back to a generic label (#612)', async ({ page }) => {
  await page.evaluate(() => {
    const p = document.getElementById('hyperplayer');
    p.removeAttribute('src');
    p.load();
    window.setTranscriptBusy(true);
  });
  expect(await pendingName(page)).toBe('Transcription');
});

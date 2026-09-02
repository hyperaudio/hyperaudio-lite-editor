// #619 — a transcription's medium wore the PREVIOUS project's picture: the player
// pinned its box to the new file's dimensions at metadata, then the stored-
// poster pass fetched the capture for the session's project — still the one
// open before — and letterboxed that into the new box (a 16:9 photo in a 4:3
// frame, corners squared off) until the newborn project's own capture arrived.
// While the loader owns the screen the poster is now the medium's own first
// frame, which matches the box by construction.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (name) => readFileSync(fileURLToPath(new URL('../fixtures/' + name, import.meta.url))).toString('base64');

// Put a video on the player the way a file pick does; `birth` also announces
// the transcript so the library adopts it as a project (with a capture).
const putVideo = (page, b64, name, birth) => page.evaluate(async ([b64, name, birth]) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const file = new File([bytes], name, { type: 'video/mp4' });
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('hyperplayer').src = URL.createObjectURL(file);
  if (!birth) return;
  document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  const lib = window.HyperaudioSave.library;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const id = lib.currentId();
    if (id !== null && (await lib.list()).some((e) => e.id === id)) break;
  }
}, [b64, name, birth]);

const picture = (page) => page.evaluate(() => new Promise((resolve) => {
  const p = document.getElementById('hyperplayer');
  const box = p.getBoundingClientRect();
  const poster = p.getAttribute('poster') || '';
  const kind = poster.startsWith('data:image/jpeg') ? 'own-frame' : poster.startsWith('blob:') ? 'stored-capture' : poster.slice(0, 16);
  const img = new Image();
  img.onload = () => resolve({ kind, posterRatio: +(img.naturalWidth / img.naturalHeight).toFixed(2), boxRatio: +(box.width / box.height).toFixed(2), video: p.videoWidth + 'x' + p.videoHeight });
  img.onerror = () => resolve({ kind, posterRatio: null, boxRatio: +(box.width / box.height).toFixed(2) });
  img.src = poster;
}));

test('while transcribing, the player shows the medium being transcribed, not the previous project', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForTimeout(1000);

  // a 16:9 project, with its stored capture on the player
  await putVideo(page, fixture('video-640x360.mp4'), 'wide.mp4', true);
  await expect.poll(() => picture(page), { timeout: 10000 }).toMatchObject({ kind: 'stored-capture', posterRatio: 1.78, boxRatio: 1.78 });

  // transcribe a 4:3 file, as an engine starts: media on the player, loader
  // in the transcript, then busy
  await putVideo(page, fixture('video-320x240.mp4'), 'narrow.mp4', false);
  await page.evaluate(() => {
    document.getElementById('hypertranscript').innerHTML = '<div class="vertically-centre"><center class="transcribing-msg">Downloading model…</center></div>';
    setTranscriptBusy(true);
  });

  // the box follows the new file (4:3) — and so must the picture in it
  await expect.poll(() => picture(page), { timeout: 10000 }).toMatchObject({ kind: 'own-frame', posterRatio: 1.33, boxRatio: 1.33, video: '320x240' });
  // and it holds: the stored-poster pass must not come back for the old project
  await page.waitForTimeout(2500);
  expect(await picture(page)).toMatchObject({ kind: 'own-frame', posterRatio: 1.33, boxRatio: 1.33 });
});

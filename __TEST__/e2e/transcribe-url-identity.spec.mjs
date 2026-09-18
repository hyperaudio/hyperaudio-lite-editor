// A URL transcription took the OPEN project's name and its media. The save
// module captures what is being transcribed at the engine's busy signal — the
// player's media and the File behind it — so a completion arriving after the
// user has switched away is still filed against the right project. The three
// cloud engines raised that signal before putting the URL on the player, so
// the capture took the outgoing project's media, named the new project after
// it, and put its src back on the player when the transcript landed.
import { test, expect } from '@playwright/test';

const MEDIA_URL = 'https://example.com/media/interview-with-ada.mp4';

// The smallest response each cloud engine will parse into three words.
const DEEPGRAM_JSON = {
  results: {
    channels: [{
      detected_language: 'en',
      alternatives: [{
        transcript: 'Brand new words.',
        words: [
          { word: 'brand', start: 0, end: 0.5, speaker: 0 },
          { word: 'new', start: 0.5, end: 1, speaker: 0 },
          { word: 'words', start: 1, end: 1.5, speaker: 0 },
        ],
      }],
    }],
  },
};

const libraryNames = (page) => page.evaluate(async () =>
  (await window.HyperaudioSave.library.list()).map((e) => e.name));

const playerSrc = (page) => page.evaluate(() => document.getElementById('hyperplayer').src);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  // the intro project is open, with its own media on the player
  await expect.poll(() => libraryNames(page)).toEqual(['How to use the Editor']);
});

test('a Deepgram URL transcription is named after its own media, not the open project', async ({ page }) => {
  await page.route('https://api.deepgram.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEEPGRAM_JSON) }));

  const openMedia = await playerSrc(page);
  expect(openMedia).not.toContain('interview-with-ada');

  await page.evaluate((url) => {
    document.getElementById('transcribe-modal').checked = true;
    document.querySelector('#token').value = 'test-token';
    const media = document.querySelector('#deepgram-media');
    media.value = url;
    media.dispatchEvent(new Event('input', { bubbles: true }));
  }, MEDIA_URL);

  // the row for the transcription in flight names what is BEING transcribed
  await page.evaluate(() => document.querySelector('#transcribe-btn').click());
  await expect.poll(() => libraryNames(page)).toContain('interview-with-ada.mp4');

  // and the finished project keeps that name, with its own media still on the
  // player rather than the project that was open when it started
  await expect.poll(() => page.evaluate(() =>
    document.querySelectorAll('#hypertranscript span[data-m]').length)).toBeGreaterThan(0);
  await expect.poll(() => libraryNames(page)).toEqual(['interview-with-ada.mp4', 'How to use the Editor']);
  expect(await playerSrc(page)).toBe(MEDIA_URL);
});

test('the engines put the media on the player before they signal busy', async ({ page }) => {
  // The contract, checked directly: at the moment the engine says it is busy,
  // the player must already hold what is being transcribed. Every cloud engine
  // is driven through the same observation.
  const engines = await page.evaluate(async (url) => {
    const results = [];
    const player = document.getElementById('hyperplayer');
    const original = window.setTranscriptBusy;
    for (const engine of [
      { name: 'Deepgram', key: '#token', media: '#deepgram-media', button: '#transcribe-btn' },
      { name: 'AssemblyAI', key: '#assemblyai-key', media: '#assemblyai-media', button: '#assemblyai-submit-btn' },
      { name: 'Parakeet (HF)', key: '#parakeet-hf-key', media: '#parakeet-hf-media', button: '#parakeet-hf-submit-btn' },
    ]) {
      const button = document.querySelector(engine.button);
      const keyField = document.querySelector(engine.key);
      const mediaField = document.querySelector(engine.media);
      if (button === null || keyField === null || mediaField === null) {
        results.push({ name: engine.name, srcAtBusy: 'NOT FOUND' });
        continue;
      }
      player.src = 'https://example.com/media/previous-project.mp4';
      keyField.value = 'test-token';
      mediaField.value = url;
      mediaField.dispatchEvent(new Event('input', { bubbles: true }));
      let srcAtBusy = null;
      window.setTranscriptBusy = function (busy) {
        if (busy === true && srcAtBusy === null) srcAtBusy = player.src;
        // swallow: this probe must not start a real transcription's bookkeeping
      };
      try { button.click(); } catch (e) { /* the network call is not the point */ }
      window.setTranscriptBusy = original;
      results.push({ name: engine.name, srcAtBusy });
    }
    return results;
  }, MEDIA_URL);

  engines.forEach((e) => expect(`${e.name}: ${e.srcAtBusy}`).toBe(`${e.name}: ${MEDIA_URL}`));
});

// The File half of the same leak. #643 fixed the NAME and the player src, but
// the previous project's File still sat in the session through a URL-mode
// birth and was written as the new project's media — a copy of the last
// recording inside a project that plays from a link. The poster pipeline then
// captured that file, so the new project wore the previous recording's
// picture in the player and in Recents alike, and no poster-side rule could
// tell: it was, by every record, the new project's own capture.
test('a URL transcription after a local-file project stores no media of its own, and wears its own picture', async ({ page }) => {
  // project A: a local file through the Deepgram picker, as a user would
  await page.evaluate(async () => {
    const res = await fetch('/__TEST__/fixtures/video-640x360.mp4');
    const dt = new DataTransfer();
    dt.items.add(new File([await res.blob()], 'local-clip.mp4', { type: 'video/mp4' }));
    const input = document.querySelector('#deepgram-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('#hypertranscript').innerHTML = '<div>Transcribing….</div>';
    window.setTranscriptBusy(true);
    await new Promise((r) => setTimeout(r, 800));
    document.querySelector('#hypertranscript').innerHTML =
      "<article><section><p><span data-m='0' data-d='400'>Local </span>"
      + "<span data-m='400' data-d='400'>clip </span></p></section></article>";
    window.setTranscriptBusy(false);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  });
  await expect.poll(() => libraryNames(page)).toContain('local-clip.mp4');
  // and it has a capture of its own, which is what used to leak
  await expect.poll(() => page.evaluate(async () => {
    const save = window.HyperaudioSave;
    try { const d = await save.storage.projectDir(save.library.currentId()); await d.getFileHandle('poster.jpg'); return true; } catch (e) { return false; }
  })).toBe(true);

  // then a URL, in the engines' order, from a video that loads fully
  await page.evaluate(async () => {
    document.querySelector('#hypertranscript').innerHTML = '<div>Transcribing….</div>';
    document.getElementById('hyperplayer').src = '/__TEST__/fixtures/video-320x240.mp4';
    window.setTranscriptBusy(true);
    await new Promise((r) => setTimeout(r, 1200));
    document.querySelector('#hypertranscript').innerHTML =
      "<article><section><p><span data-m='0' data-d='400'>Cloud </span>"
      + "<span data-m='400' data-d='400'>two </span></p></section></article>";
    window.setTranscriptBusy(false);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  });
  await expect.poll(() => libraryNames(page)).toEqual(['video-320x240.mp4', 'local-clip.mp4', 'How to use the Editor']);

  const stored = await page.evaluate(async () => {
    const save = window.HyperaudioSave;
    const list = await save.library.list();
    const cur = list.find((e) => String(e.id) === String(save.library.currentId()));
    const local = list.find((e) => e.name === 'local-clip.mp4');
    const dir = await save.storage.projectDir(cur.id);
    const media = [];
    try { const m = await dir.getDirectoryHandle('media'); for await (const [n] of m.entries()) media.push(n); } catch (e) { /* none */ }
    const bytes = async (id) => {
      try { const d = await save.storage.projectDir(id); const f = await (await d.getFileHandle('poster.jpg')).getFile(); return f.size; } catch (e) { return null; }
    };
    return { media, posterBytes: await bytes(cur.id), localPosterBytes: await bytes(local.id) };
  });
  // a link project keeps the link: no copy of another project's file
  expect(stored.media).toEqual([]);
  // a poster it may have — captured from its own URL, where the server allows
  // a cross-origin read — is its own, never the local clip's frame
  expect(stored.localPosterBytes).not.toBe(null);
  if (stored.posterBytes !== null) expect(stored.posterBytes).not.toBe(stored.localPosterBytes);

  // and the player wears this project's own picture — its capture or its
  // glyph — and not the local clip's
  await expect.poll(() => page.evaluate(async () => {
    const showing = document.getElementById('hyperplayer').getAttribute('poster') || '';
    const save = window.HyperaudioSave;
    const list = await save.library.list();
    const cur = list.find((e) => String(e.id) === String(save.library.currentId()));
    const local = list.find((e) => e.name === 'local-clip.mp4');
    const ownGlyph = window.MediaPosters.glyphUrl(cur) === showing;
    const ownCapture = (await window.MediaPosters.urlFor(cur.id, cur)) === showing;
    const localCapture = (await window.MediaPosters.urlFor(local.id, local)) === showing;
    return localCapture ? 'the local clip' : ((ownGlyph || ownCapture) ? 'its own' : showing.slice(0, 12));
  })).toBe('its own');
});

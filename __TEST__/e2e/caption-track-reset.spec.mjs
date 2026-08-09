// #356/#287 regression — the "double captions" bug that kept coming back.
//
// The <video> and its <track id="hyperplayer-vtt"> are reused across media
// swaps. Left in 'showing' mode, Chromium keeps the PREVIOUS media's active cue
// painted after track.src is reassigned, so a freshly transcribed clip shows its
// captions on top of the old clip's line. The load path (renderTranscript) was
// fixed by resetCaptionTrack — removing the stale <track> and inserting a fresh
// empty one — but the transcribe/regenerate path (hyperaudioGenerateCaptions-
// FromTranscript) reused the track and only reassigned .src, so the bug survived
// on every second transcription.
//
// This drives the from-scratch regenerate entry point twice (what each
// transcription client dispatches) and asserts the caption <track> is torn down
// and rebuilt each time: a fresh element, and never more than one track /
// TextTrack. On the pre-fix code the element was reused, so `sameElement` is true
// and the stale cue can linger — this test fails there.
import { test, expect } from '@playwright/test';
import { ladderWav } from './helpers.mjs';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('regenerating captions resets the <track>, so a prior cue cannot linger (#356/#287)', async ({ page }) => {
  const result = await page.evaluate(() => {
    const video = document.getElementById('hyperplayer');

    // First transcription: a non-audio src (so captions go 'showing', not the
    // mp3/m4a 'hidden' branch) plus a two-word transcript, then regenerate.
    video.src = 'data:video/mp4;base64,';
    document.getElementById('hypertranscript').innerHTML =
      '<article><section><p>' +
      '<span data-m="0" data-d="500">Alpha </span>' +
      '<span data-m="500" data-d="500">alpha </span></p></section></article>';
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));

    const firstTrack = document.getElementById('hyperplayer-vtt');
    firstTrack.dataset.gen = 'A';                        // stamp the gen-A element
    const trackCountAfterA = video.querySelectorAll('track').length;

    // Second transcription: new media + a different transcript, regenerate again.
    video.src = 'data:video/mp4;base64,';
    document.getElementById('hypertranscript').innerHTML =
      '<article><section><p>' +
      '<span data-m="0" data-d="500">Bravo </span></p></section></article>';
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));

    const secondTrack = document.getElementById('hyperplayer-vtt');
    return {
      trackCountAfterA,
      trackCountAfterB: video.querySelectorAll('track').length,
      textTrackCount: video.textTracks.length,
      sameElement: secondTrack === firstTrack,          // pre-fix: true (reused)
      stampSurvived: secondTrack.dataset.gen === 'A',   // pre-fix: true (reused)
      finalMode: video.textTracks[0] && video.textTracks[0].mode,
    };
  });

  expect(result.trackCountAfterA).toBe(1);              // exactly one track after gen A
  expect(result.trackCountAfterB).toBe(1);             // no track accumulation
  expect(result.textTrackCount).toBe(1);               // no stale TextTrack left behind
  expect(result.sameElement).toBe(false);              // the fix: fresh element each regenerate
  expect(result.stampSurvived).toBe(false);
  // The ::cue ghost-flush toggles mode hidden→showing; it must settle back on
  // 'showing' (the flush is a no-op if the track ends up hidden). The stale-paint
  // itself is native ::cue rendering and not inspectable headlessly — this guards
  // that the toggle path doesn't leave captions disabled.
  expect(result.finalMode).toBe('showing');
});

// The reason #356/#287 kept returning: each fix was attached to ONE path, so the
// next caption writer reintroduced it. The paint flush (hidden→showing) now lives
// in a single place — flushCaptionPaint in hyperaudio-save.js — and these tests
// assert that every path which swaps captions for a NEW document performs it.
//
// The stale line is native ::cue paint, invisible to the DOM, which is why the
// earlier tests passed while the bug was live on other routes. Instead of looking
// for pixels, record every TextTrack.mode assignment: the flush has a distinctive
// hidden→showing signature, so a path that skips it is detectable.
const recordModeAssignments = (page) => page.evaluate(() => {
  const video = document.getElementById('hyperplayer');
  const proto = Object.getPrototypeOf(video.textTracks[0]);
  const desc = Object.getOwnPropertyDescriptor(proto, 'mode');
  window.__modes = [];
  Object.defineProperty(proto, 'mode', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(value) { window.__modes.push(value); desc.set.call(this, value); },
  });
});

const flushed = (page) => page.evaluate(() => {
  // a hidden immediately followed by a showing = the overlay rebuild
  const m = window.__modes || [];
  return m.some((mode, i) => mode === 'hidden' && m[i + 1] === 'showing');
});

test('the SRT import flushes stale caption paint (#356/#287)', async ({ page }) => {
  await page.waitForFunction(() => {
    const tt = document.getElementById('hyperplayer').textTracks[0];
    return tt && tt.cues && tt.cues.length > 0;   // the intro's cues are loaded
  }, null, { timeout: 15000 });
  await recordModeAssignments(page);

  await page.evaluate(() => {
    document.getElementById('hyperplayer').src = 'data:video/mp4;base64,';
    const srt = '1\n00:00:00,320 --> 00:00:02,000\nIMPORTED caption line\n';
    const dt = new DataTransfer();
    dt.items.add(new File([srt], 'probe.srt', { type: 'application/x-subrip' }));
    const input = document.getElementById('srt');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('file-import-srt').click();
  });
  await expect(page.locator('#hypertranscript')).toContainText('IMPORTED');

  expect(await flushed(page)).toBe(true);
  // and the track was rebuilt, not reused
  expect(await page.locator('#hyperplayer track').count()).toBe(1);
  expect(await page.evaluate(() => document.getElementById('hyperplayer').textTracks.length)).toBe(1);
});

test('the regenerate path still flushes, via the shared helper (#356/#287)', async ({ page }) => {
  await recordModeAssignments(page);
  await page.evaluate(() => {
    document.getElementById('hyperplayer').src = 'data:video/mp4;base64,';
    document.getElementById('hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">Charlie </span></p></section></article>';
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  });
  expect(await flushed(page)).toBe(true);
});

// Part 3 of #356/#287 — the late, ASYNCHRONOUS write that survived the first two
// fixes. The vendored caption.js defers its VTT to 'loadedmetadata' when the
// media has not loaded yet, closing over THAT document's captions; nothing
// cancels it when the document changes. So a caption pass run while the intro
// (remote, slow) was still loading stays pending and fires when the NEXT media's
// metadata arrives, writing the previous transcript's captions over the project
// just opened — after everything the teardown and paint flush can reach.
//
// Reproduces it directly: media A that never loads metadata, a caption pass to
// arm the straggler, then a different document applied through the door.
test('a caption pass armed on unloaded media cannot overwrite the next document (#356/#287)', async ({ page }) => {
  await page.route('**/__never.mp3', async () => { /* never fulfils */ });
  await page.route('**/__real.wav', (route) => route.fulfill({
    body: ladderWav(3), contentType: 'audio/wav',
  }));

  // 1. media A, whose metadata never arrives, plus a caption pass over
  //    transcript A: caption.js parks a listener holding A's captions
  await page.evaluate(() => {
    const v = document.getElementById('hyperplayer');
    v.src = '/__never.mp3';
    document.getElementById('hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">STALEWORD </span></p></section></article>';
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.getElementById('hyperplayer').readyState)).toBe(0);

  // 2. a different document arrives the way a project open delivers one
  await page.evaluate(async () => {
    document.getElementById('hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">FRESHWORD </span></p></section></article>';
    window.applyCaptionTrack(
      'data:text/vtt,' + encodeURIComponent('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFRESHWORD\n'),
      { kind: 'captions', mode: 'showing' }
    );
    const blob = await (await fetch('/__real.wav')).blob();
    document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
  });

  // 3. the new media's metadata is exactly when the straggler would fire
  await page.waitForFunction(
    () => document.getElementById('hyperplayer').readyState >= 1, null, { timeout: 15000 });
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => {
    const t = document.getElementById('hyperplayer-vtt');
    const src = t === null ? '' : decodeURIComponent(t.src);
    const tt = document.getElementById('hyperplayer').textTracks[0];
    return { stale: /STALEWORD/.test(src), fresh: /FRESHWORD/.test(src), mode: tt && tt.mode };
  });

  expect(result.stale).toBe(false);   // pre-fix: true — the intro's captions won
  expect(result.fresh).toBe(true);
  expect(result.mode).toBe('showing');
});

// #515 — the transcribe/regenerate caption routes survived a stale caption.js
// straggler only by registration order: caption.js happens to defer its own
// write too, and the right one happened to land last. Safety by accident. The
// generateCaptionsFromTranscript funnel now arms the same guard the open path
// uses.
//
// HONESTY NOTE about these tests' teeth: they pass against today's code even
// WITHOUT the guard, because the accident also covers this synthetic attack —
// which is precisely #515's finding. Their value is as a tripwire for the
// feared future change: if the deferral is ever removed (the pass applying
// synchronously), the accident vanishes, and these tests then fail unless the
// guard — now armed by design on this route — holds the line. The third test
// below exercises the guard in isolation (a synchronous write defended by
// guardCurrentCaptionWrite, no deferral in play) and DOES fail without it.
test('a stray caption write after the transcribe pass is corrected at metadata (#515)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  const result = await page.evaluate(async () => {
    const video = document.getElementById('hyperplayer');
    video.src = '/__stalls_forever__.mp4'; // metadata pending, as with the remote intro
    video.load();
    await new Promise((r) => setTimeout(r, 50));

    // the transcribe/regenerate route writes the track and (now) arms the guard
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
    const intended = document.getElementById('hyperplayer-vtt').getAttribute('src');

    // a stale straggler lands AFTER the pass — the case ordering cannot save
    document.getElementById('hyperplayer-vtt').src =
      'data:text/vtt,' + encodeURIComponent('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nSTALE INTRO\n');

    // metadata finally arrives; the guard must re-assert the pass's write
    video.dispatchEvent(new Event('loadedmetadata'));
    await new Promise((r) => setTimeout(r, 50));
    return {
      intended: decodeURIComponent(intended).slice(0, 60),
      final: decodeURIComponent(document.getElementById('hyperplayer-vtt').getAttribute('src')).slice(0, 60),
      hasStale: document.getElementById('hyperplayer-vtt').getAttribute('src').includes('STALE'),
    };
  });

  expect(result.hasStale).toBe(false);
  expect(result.final).toBe(result.intended);
});

test('the guard is a no-op once metadata is loaded (#515)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  const result = await page.evaluate(async () => {
    const video = document.getElementById('hyperplayer');
    // demo intro may or may not have loaded in test time — force the loaded
    // state deterministically
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));

    // a write after the pass with metadata LOADED is a legitimate later write
    // (a newer caption pass, a user edit) — the guard must not fight it
    document.getElementById('hyperplayer-vtt').src =
      'data:text/vtt,' + encodeURIComponent('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nLEGITIMATE\n');
    video.dispatchEvent(new Event('loadedmetadata'));
    await new Promise((r) => setTimeout(r, 50));
    return document.getElementById('hyperplayer-vtt').getAttribute('src').includes('LEGITIMATE');
  });

  expect(result).toBe(true);
});

test('the guard alone defends a synchronous caption write (#515)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  const result = await page.evaluate(async () => {
    const video = document.getElementById('hyperplayer');
    video.src = '/__stalls_forever__.mp4';
    video.load();
    await new Promise((r) => setTimeout(r, 50));

    // the feared future shape: a route writes the track SYNCHRONOUSLY (no
    // caption.js deferral to accidentally save it) and arms the guard, as the
    // funnel now does
    const track = document.getElementById('hyperplayer-vtt');
    const intended = 'data:text/vtt,' + encodeURIComponent('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nINTENDED\n');
    track.src = intended;
    if (typeof window.guardCurrentCaptionWrite === 'function') window.guardCurrentCaptionWrite();

    // stale straggler
    track.src = 'data:text/vtt,' + encodeURIComponent('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nSTALE\n');
    video.dispatchEvent(new Event('loadedmetadata'));
    await new Promise((r) => setTimeout(r, 50));
    return document.getElementById('hyperplayer-vtt').getAttribute('src').includes('INTENDED');
  });

  expect(result).toBe(true);
});

// The caption editor's first visit after transcript edits showed PRE-EDIT
// captions: the row cache is primed at transcription time (the engines'
// caption pass runs the builder with captionMode false), transcript edits
// regenerate only the track, and entering the caption view then trusted the
// stale cache over the fresh data it had just computed. While captions are
// machine-synced the cache must never win; once hand-edited (sync off) it is
// authoritative again — that is what it exists for.
test('the caption editor reflects transcript edits on first visit', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  // prime the cache exactly as a fresh transcription does
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript')));

  // edit the transcript AFTER the prime
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'EDITED-WORD ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // first visit to the caption editor must carry the edit
  await page.click('#caption-editor-btn');
  await page.waitForFunction(() => document.querySelectorAll('#captions-display .caption').length > 0);
  const lines = await page.locator('#captions-display .caption input.line1').evaluateAll(
    (els) => els.map((e) => e.value).join(' '));
  expect(lines).toContain('EDITED-WORD');
});

// The layer BENEATH the stale-cache fix, found because the fix checked a flag
// that was lying: nothing reset updateCaptionsFromTranscript on a NEW
// transcription — it inherited the previous project's value. After any
// project with curated captions (every opened .hyperaudio with edited
// captions, every VTT import), a fresh transcription's edits updated neither
// the video captions nor the caption editor.
// (No companion test for the import routes keeping sync OFF: they set the
// flag immediately after the synchronous init dispatch, so the override
// winning is language semantics — a test would be testing dispatchEvent.)
test('a new transcription turns caption sync back on', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  // the inherited state: a previous project left sync off
  // unqualified access reaches the scripts' top-level let (a window property
  // would be a shadow — top-level let is global-lexical, not on window)
  await page.evaluate(() => { updateCaptionsFromTranscript = false; });

  // a fresh transcription lands, exactly as every engine delivers it
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  });
  expect(await page.evaluate(() => updateCaptionsFromTranscript)).toBe(true);

  // edit, then first visit to the caption editor: the edit is there
  await page.evaluate(() => {
    const span = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    span.textContent = 'POST-TRANSCRIBE-EDIT ';
    span.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#caption-editor-btn');
  await page.waitForFunction(() => document.querySelectorAll('#captions-display .caption').length > 0);
  const lines = await page.locator('#captions-display .caption input.line1').evaluateAll(
    (els) => els.map((e) => e.value).join(' '));
  expect(lines).toContain('POST-TRANSCRIBE-EDIT');
});


// Regenerate means "give me transcript-derived captions": sync resumes until
// the next hand edit. Before, regenerated captions stayed marked curated and
// silently stopped following further transcript edits.
test('Regenerate turns caption sync back on until the next caption edit', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  // curated state: a caption was hand-edited at some point
  await page.evaluate(() => { updateCaptionsFromTranscript = false; });

  // the caption view's Regenerate confirm
  await page.click('#caption-editor-btn');
  await page.waitForFunction(() => document.querySelectorAll('#captions-display .caption').length > 0);
  // entering with sync off raises the "Captions have been edited" notice,
  // which sits over the first rows and intercepts clicks (#506)
  const alertBox = page.locator('#captionsource-alert');
  if (await alertBox.isVisible()) await page.click('#captionsource-alert-ok');
  // the real flow: the floating Regenerate opens the confirm modal, Confirm
  // fires the handler and closes it (both are modal-toggle labels)
  await page.click('#regenerate-float-btn');
  await page.click('#regenerate-captions');
  await expect(page.locator('#regenerate-captions-modal')).not.toBeChecked();
  expect(await page.evaluate(() => updateCaptionsFromTranscript)).toBe(true);

  // and a hand edit flips it right back off
  await page.locator('#captions-display .caption input.line1').first().click();
  await page.keyboard.type('X');
  expect(await page.evaluate(() => updateCaptionsFromTranscript)).toBe(false);
});

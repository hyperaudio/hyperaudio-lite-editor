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
    };
  });

  expect(result.trackCountAfterA).toBe(1);              // exactly one track after gen A
  expect(result.trackCountAfterB).toBe(1);             // no track accumulation
  expect(result.textTrackCount).toBe(1);               // no stale TextTrack left behind
  expect(result.sameElement).toBe(false);              // the fix: fresh element each regenerate
  expect(result.stampSurvived).toBe(false);
});

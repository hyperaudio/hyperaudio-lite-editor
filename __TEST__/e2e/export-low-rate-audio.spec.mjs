import { test, expect } from '@playwright/test';
import { ladderWav, transcriptHtml } from './helpers.mjs';

// #579 — WebKit's WebCodecs AudioEncoder picks HE-AAC for MONO audio below
// 32 kHz, and the muxed track is unreadable to AVFoundation: a silent export
// that looks successful. Low-rate audio is therefore lifted before it reaches
// the encoder.
//
// WHAT THIS SPEC CAN AND CANNOT SHOW. It runs in Chromium, which does not
// exhibit the bug, and Playwright's WebKit is not Safari's AVFoundation
// stack — so no CI test can prove the exported FILE has audio on Safari.
// That verification lives in a WKWebView + AVAssetReader harness (see #579).
// What is provable here is the transformation: audio below 32 kHz reaches the
// encoder lifted, on every path into it, and audio at or above 32 kHz is left
// exactly as it was.

const exportAt = async (page, { sourceRate, rate = 1, format = 'm4a' }) => {
  const wav = ladderWav(3, sourceRate); // 16-bit MONO — the failing shape
  await page.route('**/__low.wav', (route) => route.fulfill({ body: wav, contentType: 'audio/wav' }));
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function');
  await page.evaluate(async () => {
    const blob = await (await fetch('/__low.wav')).blob();
    document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 1 && p.duration > 2;
  });
  // three words, one struck, so the export takes the EDITED path (which
  // re-encodes) rather than a straight copy
  await page.evaluate((html) => { document.getElementById('hypertranscript').innerHTML = html; },
    transcriptHtml([[0, 900], [1000, 900, 1], [2000, 900]]));

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(async ({ fmt, speed }) => {
    const m = document.getElementById('export-modal');
    m.checked = true; m.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1500));
    document.getElementById('export-format').value = fmt;
    document.getElementById('export-format').dispatchEvent(new Event('change'));
    const set = (id, on) => { const c = document.getElementById(id); if (c) { c.checked = on; c.dispatchEvent(new Event('change')); } };
    ['export-vtt', 'export-srt', 'export-burn', 'export-project', 'export-retime'].forEach((id) => set(id, false));
    if (speed !== 1) {
      // the speed only applies when its row is enabled — setting the number
      // alone leaves exportRate() at 1 (which made this test vacuous once)
      const adjust = document.getElementById('export-adjust');
      adjust.checked = true;
      adjust.dispatchEvent(new Event('change'));
      const speedInput = document.getElementById('export-speed');
      speedInput.value = String(speed);
      speedInput.dispatchEvent(new Event('input'));
      speedInput.dispatchEvent(new Event('change'));
    }
    document.getElementById('export-start').click();
  }, { fmt: format, speed: rate });
  const download = await downloadPromise;
  await page.waitForFunction(
    () => document.getElementById('export-status').textContent.startsWith('Done'), null, { timeout: 120000 });

  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return audioSampleRate(Buffer.concat(chunks));
};

// The rate the muxed file actually declares, read from the MP4 audio sample
// entry. (decodeAudioData is no good here: it resamples to the AudioContext's
// own rate, so it reports the browser's device rate rather than the file's.)
// Layout after the 'mp4a' fourcc: reserved[6] + data_ref[2] + version/rev/
// vendor[8] + channels[2] + samplesize[2] + pre_defined[2] + reserved[2],
// then samplerate as 16.16 fixed point.
function audioSampleRate(bytes) {
  const at = bytes.indexOf('mp4a', 0, 'ascii');
  const mv = bytes.indexOf('mvhd', 0, 'ascii');
  // mvhd v0: version+flags[4], creation[4], modification[4], timescale[4], duration[4]
  const duration = mv === -1 ? null
    : bytes.readUInt32BE(mv + 20) / bytes.readUInt32BE(mv + 16);
  if (at === -1) return { sampleRate: null, duration, size: bytes.length };
  // the integer half of the 16.16 field (a >> 16 here sign-extends: 0xac44... reads negative)
  return { sampleRate: bytes.readUInt16BE(at + 28), duration, size: bytes.length };
}

test('16 kHz mono audio is lifted before it reaches the encoder (#579)', async ({ page }) => {
  const out = await exportAt(page, { sourceRate: 16000 });
  expect(out.sampleRate).toBeGreaterThanOrEqual(32000); // clear of WebKit's HE-AAC cliff
  expect(out.sampleRate).toBe(48000);                   // 16000 divides 48000 exactly
  expect(out.size).toBeGreaterThan(2000);               // and it still has audio in it
});

test('22.05 kHz mono lifts to a rate it divides exactly (#579)', async ({ page }) => {
  const out = await exportAt(page, { sourceRate: 22050 });
  expect(out.sampleRate).toBe(44100);
});

test('the speed-change path lifts too — the stretcher is not a hole (#579)', async ({ page }) => {
  const out = await exportAt(page, { sourceRate: 16000, rate: 1.5 });
  // First prove the STRETCHER actually ran: at 1.5x the ~1.9s of kept audio
  // must come out around 1.3s. Without this the test can pass while never
  // exercising the path it exists for.
  expect(out.duration).toBeGreaterThan(0.9);
  expect(out.duration).toBeLessThan(1.6);
  expect(out.sampleRate).toBeGreaterThanOrEqual(32000);
});

test('44.1 kHz audio is passed through untouched (#579)', async ({ page }) => {
  const out = await exportAt(page, { sourceRate: 44100 });
  expect(out.sampleRate).toBe(44100); // no needless resample on the common path
});

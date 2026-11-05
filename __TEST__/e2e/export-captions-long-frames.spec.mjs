// #769 — burned-in captions held through long source frames. A screen
// recording writes a frame only when the picture changes, so a static page is
// one frame lasting seconds. The export drew one output frame per source
// frame, caption as it stood at that moment, and gave it the source frame's
// length: every cue change inside those seconds was never drawn. The captions
// froze and jumped wherever the picture was still, while the audio ran on.
// Now a frame that outlasts a tick is emitted again with the caption redrawn
// at each tick. Without captions the frames are written as they were.
import { test, expect } from '@playwright/test';
import { transcriptHtml } from './helpers.mjs';

// A short video whose middle frame lasts six seconds, as a screen recording's
// does, built in the page by the same library the export uses: ten frames a
// second for half a second, one frame from 0.5 to 6.5, then ten a second to 7.
const buildLongFrameVideo = (page) => page.evaluate(async () => {
  const mb = await import('mediabunny');
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const c = canvas.getContext('2d');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
  const source = new mb.CanvasSource(canvas, { codec: 'vp9', bitrate: 500000 });
  output.addVideoTrack(source);
  await output.start();
  const frames = [];
  for (let i = 0; i < 5; i++) frames.push([i * 0.1, 0.1]);
  frames.push([0.5, 6]);
  for (let i = 0; i < 5; i++) frames.push([6.5 + i * 0.1, 0.1]);
  for (const [t, d] of frames) {
    c.fillStyle = `hsl(${Math.round(t * 40)} 60% 50%)`;
    c.fillRect(0, 0, 320, 180);
    await source.add(t, d);
  }
  source.close();
  await output.finalize();
  const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
  // what the export's decoder will see of it: the frame lengths
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  const sink = new mb.EncodedPacketSink(track);
  const durations = [];
  for await (const p of sink.packets()) durations.push(Math.round(p.duration * 100) / 100);
  document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
  return durations;
});

// the exported file's video frame timestamps, read back in the page
const frameTimes = async (page, download) => {
  const fs = await import('node:fs/promises');
  const b64 = (await fs.readFile(await download.path())).toString('base64');
  return page.evaluate(async ({ data, name }) => {
    const mb = await import('mediabunny');
    const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    const blob = new Blob([bytes], { type: name.endsWith('.webm') ? 'video/webm' : 'video/mp4' });
    const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(blob) });
    const track = await input.getPrimaryVideoTrack();
    const sink = new mb.EncodedPacketSink(track);
    const times = [];
    for await (const p of sink.packets()) times.push(p.timestamp);
    return times.sort((a, b) => a - b);
  }, { data: b64, name: download.suggestedFilename() });
};

// cues that change every second through the long frame
const CUE_STARTS = [1, 2, 3, 4, 5];
const VTT = ['WEBVTT', '']
  .concat(CUE_STARTS.flatMap((s) => [`00:00:0${s}.000 --> 00:00:0${s}.900`, `cue ${s}`, '']))
  .join('\n');

const TICK = 1 / 15;
const near = (times, at) => times.filter((t) => t >= at - TICK - 0.002 && t <= at + 0.002);

const settle = (page, id, value) => page.evaluate(([i, v]) => {
  const el = document.getElementById(i);
  if (el.type === 'radio' || el.type === 'checkbox') el.checked = v; else el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, value]);

// words at the start and the end, and one in the middle of the long frame
// that a test may strike, cutting a second out of the static stretch
const setup = async (page, { strike = false } = {}) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const durations = await buildLongFrameVideo(page);
  // the fixture reproduces the condition: one source frame six seconds long
  expect(Math.max(...durations)).toBe(6);
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 2 && p.videoWidth === 320;
  });
  const words = [[0, 500, 0], [2000, 1000, strike ? 1 : 0], [6500, 500, 0]];
  const sections = await page.evaluate(([vtt, html]) => {
    document.getElementById('hyperplayer-vtt').src = 'data:text/vtt,' + encodeURIComponent(vtt);
    document.getElementById('hypertranscript').innerHTML = html;
    return window.getPlayableSections();
  }, [VTT, transcriptHtml(words)]);
  await page.evaluate(() => {
    document.activeElement && document.activeElement.blur();
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
  const video = await page.evaluate(() =>
    [...document.querySelectorAll('#export-format option')].map((o) => o.value).find((v) => v === 'mp4' || v === 'webm'));
  test.skip(!video, 'no video encoder in this browser');
  await page.selectOption('#export-format', video);
  await settle(page, strike ? 'export-source-edited' : 'export-source-entire', true);
  return sections;
};

const exportFile = async (page) => {
  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-start');
  const download = await downloadPromise;
  await page.waitForFunction(() => document.getElementById('export-status').textContent.startsWith('Done'), null, { timeout: 120000 });
  return frameTimes(page, download);
};

test('with captions burned in, a long source frame is redrawn at every cue change (#769)', async ({ page }) => {
  await setup(page);
  await settle(page, 'export-burn', true);
  const times = await exportFile(page);
  // a frame begins within a tick before each cue start, so no cue change
  // falls inside a frame that holds the previous caption
  for (const start of CUE_STARTS) {
    expect(near(times, start).length, `a frame starts near ${start}s: ${times.map((t) => t.toFixed(2)).join(' ')}`).toBeGreaterThan(0);
  }
  // and the six-second frame became ninety ticks, not one
  expect(times.length).toBeGreaterThanOrEqual(11 + 85);
});

test('a cut inside the long frame: the ticks stop where the picture does, and the frames after the cut keep their places (#769)', async ({ page }) => {
  const sections = await setup(page, { strike: true });
  expect(sections.length).toBe(2);
  // the cut on the edited timeline, and where source time resumes
  const cutAt = sections[0].end;
  const resume = sections[1].start;
  const onEdited = (src) => (src < cutAt ? src : cutAt + (src - resume));
  await settle(page, 'export-burn', true);
  const times = await exportFile(page);
  // the long frame is ticked up to the cut, and again from the cut to its
  // true end, then the frames at 6.5s onward land where the edit puts them
  for (const start of CUE_STARTS) {
    if (start > cutAt && start < resume) continue;         // this cue was cut away
    expect(near(times, onEdited(start)).length, `a frame starts near cue ${start}s`).toBeGreaterThan(0);
  }
  const tail = times.filter((t) => t > onEdited(6.5) - 0.01);
  expect(tail.map((t) => +t.toFixed(2))).toEqual([6.5, 6.6, 6.7, 6.8, 6.9].map((s) => +onEdited(s).toFixed(2)));
  // no frames squeezed together: the ticks never ran past the picture's end
  for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThan(0.005);
});

test('without captions, the long source frame is written as the one frame it is (#769)', async ({ page }) => {
  // the edited export takes the frame-by-frame path with nothing to burn in
  const sections = await setup(page, { strike: true });
  await settle(page, 'export-burn', false);
  const times = await exportFile(page);
  // the eleven source frames, and the long one a second time: it is the first
  // frame of the section after the cut, clamped to the cut, as it always was
  expect(times.length).toBe(12);
  // between the first half second and the tail there is only that one
  const cutAt = sections[0].end;
  const middle = times.filter((t) => t > 0.55 && t < cutAt + (6.5 - sections[1].start) - 0.01);
  expect(middle.length).toBe(1);
  expect(Math.abs(middle[0] - cutAt)).toBeLessThan(0.01);
});

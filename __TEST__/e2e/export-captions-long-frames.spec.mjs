// #769 — burned-in captions held through long source frames. A screen
// recording writes a frame only when the picture changes, so a static page is
// one frame lasting seconds. The export drew one output frame per source
// frame, caption as it stood at that moment, and gave it the source frame's
// length: every cue change inside those seconds was never drawn. The captions
// froze and jumped wherever the picture was still, while the audio ran on.
// Now a frame that outlasts a tick is emitted again with the caption redrawn
// at each tick. Without captions the frames are written as they were.
import { test, expect } from '@playwright/test';

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

const settle = (page, id, value) => page.evaluate(([i, v]) => {
  const el = document.getElementById(i);
  if (el.type === 'radio' || el.type === 'checkbox') el.checked = v; else el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, value]);

const setup = async (page) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const durations = await buildLongFrameVideo(page);
  // the fixture reproduces the condition: one source frame six seconds long
  expect(Math.max(...durations)).toBe(6);
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 2 && p.videoWidth === 320;
  });
  await page.evaluate((vtt) => {
    document.getElementById('hyperplayer-vtt').src = 'data:text/vtt,' + encodeURIComponent(vtt);
    document.getElementById('hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">one </span><span data-m="6500" data-d="500">two </span></p></section></article>';
  }, VTT);
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
  await settle(page, 'export-source-entire', true);
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
  const TICK = 1 / 15;
  for (const start of CUE_STARTS) {
    const near = times.filter((t) => t >= start - TICK - 0.002 && t <= start + 0.002);
    expect(near.length, `a frame starts near ${start}s: ${times.map((t) => t.toFixed(2)).join(' ')}`).toBeGreaterThan(0);
  }
  // and the six-second frame became ninety ticks, not one
  expect(times.length).toBeGreaterThanOrEqual(11 + 85);
});

test('without captions, the long source frame is written as the one frame it is (#769)', async ({ page }) => {
  await setup(page);
  await settle(page, 'export-burn', false);
  const times = await exportFile(page);
  expect(times.length).toBe(11);
  expect(times.filter((t) => t > 0.55 && t < 6.45)).toEqual([]);
});

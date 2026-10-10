// #722 — every re-encoded MP4 and M4A played its audio about 40 ms late in
// Chrome, ffmpeg and VLC: the AAC encoder's priming run (2112 samples for
// Apple's encoder) was written as the start of the track. The run's length
// is measured once per page, and the audio track starts that much before
// zero, which the muxer writes as an edit list every player honours. Needs
// an AAC encoder, so these tests skip where there is none.
import { test, expect } from '@playwright/test';

const FIXTURE = '/__TEST__/fixtures/video-640x360.mp4';

const setup = async (page) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate((src) => { document.getElementById('hyperplayer').src = src; }, FIXTURE);
  await page.waitForFunction(() => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 2 && p.videoWidth === 640;
  });
  await page.evaluate(() => {
    document.getElementById('hypertranscript').innerHTML =
      '<article><section><p><span data-m="0" data-d="500">one </span><span data-m="500" data-d="500">two </span></p></section></article>';
  });
  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
};

const formats = (page) => page.evaluate(() => [...document.querySelectorAll('#export-format option')].map((o) => o.value));

const settle = (page, id, value) => page.evaluate(([i, v]) => {
  const el = document.getElementById(i);
  if (el.type === 'radio' || el.type === 'checkbox') el.checked = v; else el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, value]);

// export, and read the audio track's first packet time back with mediabunny,
// which applies the file's edit list: a track that starts before zero has one
const firstAudioPacket = async (page, format, burn) => {
  await settle(page, 'export-format', format);
  // something that re-encodes: burned captions, or a change of speed. An
  // untouched export is a copy, and keeps the source's own edit list.
  if (burn) await settle(page, 'export-burn', true);
  else { await settle(page, 'export-adjust', true); await settle(page, 'export-speed', '1.25'); }
  const downloadPromise = page.waitForEvent('download');
  await page.click('#export-start');
  const download = await downloadPromise;
  await page.waitForFunction(() => document.getElementById('export-status').textContent.startsWith('Done'), null, { timeout: 120000 });
  const fs = await import('node:fs/promises');
  const b64 = (await fs.readFile(await download.path())).toString('base64');
  return page.evaluate(async (data) => {
    const mb = await import('mediabunny');
    const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    const input = new mb.Input({ source: new mb.BufferSource(bytes.buffer), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    const firstTimestamp = await track.getFirstTimestamp();
    // the roll groups, by a walk of the boxes: sgpd and sbgp inside the audio track
    const dv = new DataView(bytes.buffer);
    const types = [];
    const walk = (start, end) => {
      let o = start;
      while (o + 8 <= end) {
        let size = dv.getUint32(o); if (size === 0) size = end - o;
        const t = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
        types.push(t);
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(t)) walk(o + 8, o + size);
        o += size;
      }
    };
    if (bytes[4] === 0x66 && bytes[5] === 0x74) walk(0, bytes.length); // an MP4 ('ftyp'), not a WebM
    return { codec: track.codec, sampleRate: track.sampleRate, timestamp: firstTimestamp,
      rollGroups: types.includes('sgpd') && types.includes('sbgp'), playable: (await track.computePacketStats()).packetCount > 0 };
  }, b64);
};

test('the priming is measured once, and is a frame or more of samples', async ({ page }) => {
  await setup(page);
  test.skip(!(await formats(page)).includes('m4a'), 'no AAC encoder in this browser');
  const first = await page.evaluate(() => window.MediaExportEncoders.aacPriming());
  expect(first).toBeGreaterThanOrEqual(1024);
  expect(first).toBeLessThanOrEqual(4096);
  // the same answer again, without another measurement
  expect(await page.evaluate(() => window.MediaExportEncoders.aacPriming())).toBe(first);
});

test('an MP4 with burned captions starts its audio before zero by the priming, so the audio proper lands at zero', async ({ page }) => {
  await setup(page);
  test.skip(!(await formats(page)).includes('mp4'), 'no H.264/AAC encoder in this browser');
  const priming = await page.evaluate(() => window.MediaExportEncoders.aacPriming());
  const audio = await firstAudioPacket(page, 'mp4', true);
  expect(audio.codec).toBe('aac');
  expect(audio.timestamp).toBeCloseTo(-priming / audio.sampleRate, 3);
  expect(audio.rollGroups).toBe(true); // for Apple's players, which would otherwise strip the priming twice
  expect(audio.playable).toBe(true);
});

test('a re-encoded M4A export carries the same edit list', async ({ page }) => {
  await setup(page);
  test.skip(!(await formats(page)).includes('m4a'), 'no AAC encoder in this browser');
  const priming = await page.evaluate(() => window.MediaExportEncoders.aacPriming());
  const audio = await firstAudioPacket(page, 'm4a', false);
  expect(audio.timestamp).toBeCloseTo(-priming / audio.sampleRate, 3);
  expect(audio.rollGroups).toBe(true);
  expect(audio.playable).toBe(true);
});

test('a WebM export is untouched: Opus signals its own delay', async ({ page }) => {
  await setup(page);
  test.skip(!(await formats(page)).includes('webm'), 'no WebM encoder in this browser');
  const audio = await firstAudioPacket(page, 'webm', true);
  expect(audio.codec).toBe('opus');
  expect(audio.timestamp).toBeGreaterThanOrEqual(-0.001);
});

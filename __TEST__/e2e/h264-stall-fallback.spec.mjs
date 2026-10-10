// #721 — on macOS 27.0 WebKit's H.264 encoder never emits a packet in Main
// or High profile in the default latency mode, and an MP4 export that
// re-encodes sits on its status line for ever. The encoder is asked once per
// page, and only where it stalls is Baseline profile used instead. These
// tests need an H.264 encoder, which Playwright's Chromium does not ship;
// they run in a browser that has one (Chrome) and skip elsewhere.
import { test, expect } from '@playwright/test';

const FIXTURE = '/__TEST__/fixtures/video-640x360.mp4';

// A stand-in for the bug: an encoder that swallows every packet, and whose
// flush never resolves, for Main and High profile in quality mode. Baseline,
// and realtime mode, work as the real encoder does.
const STALLING_ENCODER = () => {
  const Real = window.VideoEncoder;
  window.VideoEncoder = class extends Real {
    constructor(init) {
      let swallow = () => false;
      super({
        output: (chunk, meta) => { if (!swallow()) init.output(chunk, meta); },
        error: init.error,
      });
      this._stalls = false;
      swallow = () => this._stalls;
    }
    configure(config) {
      this._stalls = /^avc1\.(64|4d)/i.test(config.codec) && config.latencyMode !== 'realtime';
      return super.configure(config);
    }
    flush() { return this._stalls ? new Promise(() => {}) : super.flush(); }
  };
};

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
    document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  });
  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
};

const settle = (page, id, value) => page.evaluate(([i, v]) => {
  const el = document.getElementById(i);
  if (el.type === 'radio' || el.type === 'checkbox') el.checked = v; else el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, value]);

// the formats the open dialog offers (video ones only with video on the player)
const formats = (page) => page.evaluate(() => [...document.querySelectorAll('#export-format option')].map((o) => o.value));

// export with captions burned (so the video is re-encoded), and read the
// result's H.264 profile back with mediabunny
const exportProfile = async (page) => {
  await settle(page, 'export-format', 'mp4');
  await settle(page, 'export-burn', true);
  // every status the dialog shows on the way, however briefly
  await page.evaluate(() => {
    window.__statuses = [];
    const el = document.getElementById('export-status');
    new MutationObserver(() => window.__statuses.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
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
    const track = await input.getPrimaryVideoTrack();
    return { codec: await track.getCodecParameterString(), frames: await track.computePacketStats().then((s) => s.packetCount),
      statuses: window.__statuses };
  }, b64);
};

test('a working encoder is left alone: the check says ok and the export keeps its profile', async ({ page }) => {
  await setup(page);
  test.skip(!(await formats(page)).includes('mp4'), 'no H.264 encoder in this browser');
  expect(await page.evaluate(() => window.MediaExportEncoders.h264Check())).toBe('ok');
  const out = await exportProfile(page);
  expect(out.codec).not.toMatch(/^avc1\.42/);
  expect(out.frames).toBeGreaterThan(0);
});

test('where Main and High stall, the check says so and the export completes in Baseline, saying it did', async ({ page }) => {
  await setup(page);
  test.skip(!(await formats(page)).includes('mp4'), 'no H.264 encoder in this browser');
  await page.evaluate(STALLING_ENCODER);
  await page.evaluate(() => window.MediaExportEncoders.resetH264Check());
  const t0 = Date.now();
  expect(await page.evaluate(() => window.MediaExportEncoders.h264Check())).toBe('stalled');
  expect(Date.now() - t0).toBeLessThan(4000); // the check gives up quickly
  const out = await exportProfile(page);
  expect(out.codec).toMatch(/^avc1\.42/);
  expect(out.frames).toBeGreaterThan(0);
  expect(out.statuses.some((s) => s.includes('compatible video encoder'))).toBe(true);
});

test('without WebCodecs H.264 the check is unknown and changes nothing', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    window.VideoEncoder = class { static isConfigSupported() { return Promise.resolve({ supported: false }); } };
    window.MediaExportEncoders.resetH264Check();
  });
  expect(await page.evaluate(() => window.MediaExportEncoders.h264Check())).toBe('unknown');
});

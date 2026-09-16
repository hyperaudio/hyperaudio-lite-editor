// #627 — transcribing from a URL used to fetch the WHOLE file into memory,
// twice over: once to sniff whether it was HLS, then again to decode. A 5.85
// GB video killed the tab, and the message blamed the worker. The URL path
// now sniffs a few kilobytes and reads the audio track alone over range
// requests, with an honest refusal when neither is possible.
import { test, expect } from '@playwright/test';

const FIXTURE = '/__TEST__/fixtures/video-320x240.mp4';   // 1s, h264 + aac

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('the audio track alone is read, at 16 kHz, without downloading the video (#627)', async ({ page }) => {
  const ranged = [];
  page.on('request', (r) => {
    if (r.url().includes('video-320x240.mp4')) ranged.push(r.headers().range || 'full');
  });

  const result = await page.evaluate(async (url) => {
    const samples = await readAudioFromUrl(new URL(url, location.href).href, null, () => {});
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
    return { length: samples.length, peak, type: samples.constructor.name };
  }, FIXTURE);

  expect(result.type).toBe('Float32Array');
  // a one-second fixture at 16 kHz, give or take the encoder's padding
  expect(result.length).toBeGreaterThan(12000);
  expect(result.length).toBeLessThan(20000);
  expect(result.peak).toBeGreaterThan(0.05);      // the sine is really there

  // the sniff is a range request, not the file
  expect(ranged.length).toBeGreaterThan(0);
  expect(ranged[0]).toBe('bytes=0-65535');
});

test('a huge file whose audio cannot be read is refused, not crashed into (#627)', async ({ page }) => {
  // a host that answers, declares six gigabytes, and serves nothing a demuxer
  // can use — the case that killed the tab. Content-Range is NOT exposed to
  // JS cross-origin (the real CDN does not expose it either), so the size has
  // to come from the HEAD probe, exactly as it would in the wild.
  await page.route('**/enormous.mp4*', (route) => route.fulfill({
    status: route.request().method() === 'HEAD' ? 200 : 206,
    headers: {
      'content-type': 'video/mp4',
      'content-length': '5854000287',
      'accept-ranges': 'bytes',
    },
    body: route.request().method() === 'HEAD' ? '' : 'x'.repeat(4096),
  }));

  const message = await page.evaluate(async () => {
    try {
      await readAudioFromUrl('https://example.test/enormous.mp4', null, () => {});
      return 'no error';
    } catch (e) {
      return e.message;
    }
  });

  expect(message).toContain('5.9 GB');
  expect(message).toContain('too large');
  expect(message).toMatch(/local copy|\.m3u8/);
});

test('a small file still falls back to a whole-file decode when extraction fails (#627)', async ({ page }) => {
  // no content-length worth worrying about: the old path is still allowed,
  // so nothing that worked before stops working
  const wav = await page.evaluate(async () => {
    const rate = 16000;
    const frames = rate / 2;
    const buffer = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buffer);
    const tag = (o, s) => { for (let i = 0; i < 4; i += 1) view.setUint8(o + i, s.charCodeAt(i)); };
    tag(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); tag(8, 'WAVE');
    tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    tag(36, 'data'); view.setUint32(40, frames * 2, true);
    for (let i = 0; i < frames; i += 1) view.setInt16(44 + i * 2, Math.round(Math.sin(i / 8) * 20000), true);
    return Array.from(new Uint8Array(buffer));
  });
  await page.route('**/tone.wav*', (route) => route.fulfill({
    status: 200,
    headers: { 'content-type': 'audio/wav', 'content-length': String(wav.length) },
    body: Buffer.from(wav),
  }));

  const length = await page.evaluate(async () => {
    const samples = await readAudioFromUrl('https://example.test/tone.wav', null, () => {});
    return samples.length;
  });
  expect(length).toBeGreaterThan(4000);
});

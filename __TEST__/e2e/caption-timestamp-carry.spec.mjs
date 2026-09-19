// The exporter's caption timestamps could carry a four-digit millisecond
// field: hours, minutes and seconds were floored separately and the fraction
// rounded on its own, so 1.9995 s printed as 00:00:01.1000 (#657). A cue at
// 3.999 s exported at 2× hits it. Both the WebVTT and the SRT formatter share
// the clock, so both are checked.
import { test, expect } from '@playwright/test';

test('a fraction that rounds up carries into the seconds, in WebVTT and SRT (#657)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  const out = await page.evaluate(() => {
    const C = window.MediaExportCaptions;
    const cues = [
      { start: 1.9995, end: 3.0, lines: ['a'] },
      { start: 59.9996, end: 61, lines: ['b'] },
      { start: 3599.9995, end: 3601, lines: ['c'] },
    ];
    return { vtt: C.cuesToVtt(cues), srt: C.cuesToSrt(cues) };
  });
  expect(out.vtt).toContain('00:00:02.000 --> 00:00:03.000');
  expect(out.vtt).toContain('00:01:00.000 --> 00:01:01.000');
  expect(out.vtt).toContain('01:00:00.000 --> 01:00:01.000');
  expect(out.srt).toContain('00:00:02,000 --> 00:00:03,000');
  expect(out.srt).toContain('01:00:00,000 --> 01:00:01,000');
  // no field anywhere is wider than three digits
  expect(out.vtt).not.toMatch(/\.\d{4}/);
  expect(out.srt).not.toMatch(/,\d{4}/);
});

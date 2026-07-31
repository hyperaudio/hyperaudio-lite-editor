// The export modal's target length is entered as separate minutes/seconds
// boxes (#441): the old single m:ss text field read a bare "15" as 15
// SECONDS, so a 16-minute video typed as "15" computed a 64x rate, slammed
// into the 4x cap and rewrote the field to ~4:00 with no explanation.
// Explicit unit boxes remove the guessing; impossible targets now say in the
// readout why the rate was capped instead of snapping silently.
import { test, expect } from '@playwright/test';
import { ladderWav, transcriptHtml } from './helpers.mjs';

const setup = async (page, seconds) => {
  const wav = ladderWav(seconds, 8000);
  await page.route('**/__ladder.wav', (route) => route.fulfill({ body: wav, contentType: 'audio/wav' }));
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.getPlayableSections === 'function');
  await page.evaluate(async () => {
    const blob = await (await fetch('/__ladder.wav')).blob();
    document.getElementById('hyperplayer').src = URL.createObjectURL(blob);
  });
  await page.waitForFunction((s) => {
    const p = document.getElementById('hyperplayer');
    return p.readyState >= 1 && p.duration > s - 1;
  }, seconds);
  const words = Array.from({ length: seconds }, (_, i) => [i * 1000, 1000, 0]);
  await page.evaluate((html) => {
    document.getElementById('hypertranscript').innerHTML = html;
  }, transcriptHtml(words));
  await page.evaluate(() => {
    const m = document.getElementById('export-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('export-format').options.length > 0, null, { timeout: 60000 });
  await page.evaluate(() => {
    const c = document.getElementById('export-adjust');
    c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const enterLength = async (page, min, sec) => {
  await page.locator('#export-length-min').fill(String(min));
  await page.locator('#export-length-sec').fill(String(sec));
  await page.locator('#export-length-sec').press('Enter');
  return page.evaluate(() => ({
    speed: document.getElementById('export-speed').value,
    min: document.getElementById('export-length-min').value,
    sec: document.getElementById('export-length-sec').value,
    readout: document.getElementById('export-adjust-readout').textContent,
  }));
};

test('minute/second boxes drive the rate; the boxes keep the requested length', async ({ page }) => {
  await setup(page, 60); // 1 minute of content

  // enabling the adjust panel prefills the boxes with the content length
  const initial = await page.evaluate(() => ({
    min: document.getElementById('export-length-min').value,
    sec: document.getElementById('export-length-sec').value,
  }));
  expect(initial).toEqual({ min: '1', sec: '0' });

  const half = await enterLength(page, 0, 30);
  expect(half.speed).toBe('2');
  // the boxes keep what was typed — the readout carries the outcome
  expect(half).toMatchObject({ min: '0', sec: '30' });

  const double = await enterLength(page, 2, 0);
  expect(double.speed).toBe('0.5');

  // the original bug scenario, unit-safe now: 15 in the MINUTES box on short
  // content caps at the 0.25x floor and says so — it can never read as 15s
  const fifteen = await enterLength(page, 15, 0);
  expect(fifteen.speed).toBe('0.25');
  expect(fifteen.readout).toContain('capped at 0.25×');
  expect(fifteen.readout).toContain('longest is 4:00');

  // an over-full seconds box rolls over instead of erroring
  const rolled = await enterLength(page, 1, 90);
  expect(rolled.speed).toBe('0.4'); // 60s / 150s
  expect(rolled.min).toBe('2');
  expect(rolled.sec).toBe('30');
});

test('an impossible target explains the cap instead of snapping silently', async ({ page }) => {
  await setup(page, 60);
  // 60s into 6s wants 10x → capped at 4x, with the reachable floor named
  const capped = await enterLength(page, 0, 6);
  expect(capped.speed).toBe('4');
  expect(capped.readout).toContain('capped at 4×');
  expect(capped.readout).toContain('shortest is 0:15');
  expect(capped).toMatchObject({ min: '0', sec: '6' }); // the request stands
  expect(capped.readout).toContain('→ 0:15 at 4×');     // the outcome is shown
});

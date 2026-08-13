import { test, expect } from '@playwright/test';

// An object URL made from an OPFS file is a SNAPSHOT: once that file is
// rewritten — which any save that re-writes media does — the URL still plays
// from buffered data but can no longer be read back. The media exporter read
// the player's src for its bytes, so those projects failed with a raw
// "Failed to fetch" while others exported fine. The exporter now takes the
// library's stored file first, and says something true when it cannot.

const makeVideoProject = async (page) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#48c'; ctx.fillRect(0, 0, 320, 180);
    const rec = new MediaRecorder(canvas.captureStream(10), { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    let n = 0;
    await new Promise((done) => {
      const t = setInterval(() => { ctx.fillRect(0, 0, 320, 180); if (++n >= 15) { clearInterval(t); rec.stop(); done(); } }, 100);
    });
    await stopped;
    const file = new File(chunks, 'conference talk.webm', { type: 'video/webm' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('hyperplayer').src = URL.createObjectURL(file);
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    for (let i = 0; i < 60 && window.HyperaudioSave.library.currentId() === null; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  await page.waitForTimeout(1200);
};

test('the exporter reads the stored media, not a stale player URL', async ({ page }) => {
  await makeVideoProject(page);

  // exactly the failure mode: the player's object URL is dead, as it is once
  // the OPFS file behind it has been rewritten
  await page.evaluate(() => {
    const p = document.getElementById('hyperplayer');
    URL.revokeObjectURL(p.src);
  });

  const bytes = await page.evaluate(async () => {
    const blob = await window.HyperaudioSave.currentMediaFile();
    return blob ? blob.size : 0;
  });
  expect(bytes).toBeGreaterThan(1000); // the library still has the real file

  const status = await page.evaluate(async () => {
    const m = document.getElementById('export-modal');
    m.checked = true; m.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1500));
    const set = (id, on) => { const c = document.getElementById(id); if (c) { c.checked = on; c.dispatchEvent(new Event('change')); } };
    ['export-vtt', 'export-burn', 'export-project', 'export-srt'].forEach((id) => set(id, false));
    set('export-interactive', true);
    document.getElementById('export-start').click();
    for (let i = 0; i < 120; i += 1) {
      const s = document.getElementById('export-status').textContent;
      if (s.startsWith('Done') || s.toLowerCase().includes('fail')) return s;
      await new Promise((r) => setTimeout(r, 300));
    }
    return 'TIMEOUT ' + document.getElementById('export-status').textContent;
  });
  expect(status).toContain('Done');
});

// #735 — toggling Timecodes forced one layout per paragraph: reposition()
// wrote a label's style and then read the next paragraph's rectangle, so the
// browser laid the whole transcript out again between every pair. Reads and
// writes are now in two passes, and the toggle costs the same few layouts
// however long the transcript is.
import { test, expect } from '@playwright/test';

const PARAGRAPHS = 3000;

test('toggling Timecodes on a long transcript is a few layouts, not one per paragraph', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate((n) => {
    let html = '<article><section>';
    for (let i = 0; i < n; i++) {
      const ms = i * 4000;
      html += `<p><span data-m="${ms}" data-d="900">Paragraph </span><span data-m="${ms + 1000}" data-d="900">number </span><span data-m="${ms + 2000}" data-d="900">${i} </span></p>`;
    }
    html += '</section></article>';
    document.getElementById('hypertranscript').innerHTML = html;
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  }, PARAGRAPHS);
  await expect.poll(() => page.locator('#hypertranscript p').count()).toBe(PARAGRAPHS);

  // layouts forced inside the toggle, counted at the reads that force them
  const result = await page.evaluate(() => {
    let forced = 0;
    const proto = Element.prototype;
    const original = proto.getBoundingClientRect;
    let dirty = true; // the first read after any write forces a layout
    const observer = new MutationObserver(() => { dirty = true; });
    observer.observe(document.querySelector('.transcript-holder'), { attributes: true, subtree: true, childList: true, attributeFilter: ['style', 'class'] });
    proto.getBoundingClientRect = function () {
      // a style write since the last read means this read forces a layout;
      // mutation records are delivered asynchronously, so look directly
      if (observer.takeRecords().length > 0 || dirty) { forced += 1; dirty = false; }
      return original.call(this);
    };
    const t0 = performance.now();
    const c = document.getElementById('show-timecodes');
    c.checked = true;
    c.dispatchEvent(new Event('change'));
    const ms = performance.now() - t0;
    proto.getBoundingClientRect = original;
    observer.disconnect();
    return { ms, forced, labels: document.querySelectorAll('.para-timecode').length };
  });
  console.log(`timecodes toggle: ${result.ms.toFixed(0)} ms, ${result.forced} forced layouts, ${result.labels} labels`);
  expect(result.labels).toBe(PARAGRAPHS);
  // the toggle used to force one layout per paragraph
  expect(result.forced).toBeLessThan(10);
  expect(result.ms).toBeLessThan(2000);
});

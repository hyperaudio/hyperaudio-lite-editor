// The media link field was capped at 320 px in a wider dialog, and a pasted
// address scrolled to its tail, so a long URL showed as its file name (#782).
// The field takes the dialog's width, and after a paste it reads from the
// start.
import { test, expect } from '@playwright/test';

const URL_TEXT = 'https://lab.hyperaud.io/video/BBC/education.mp4';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

const measure = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  const cs = getComputedStyle(el);
  const parent = el.parentElement.getBoundingClientRect();
  return { maxWidth: cs.maxWidth, width: el.getBoundingClientRect().width, parentWidth: parent.width, classes: el.className };
}, selector);

test('the transcribe dialogs\' link fields take the dialog\'s width', async ({ page }) => {
  await page.evaluate(() => {
    document.getElementById('transcribe-modal').checked = true;
    document.getElementById('service-cloud').checked = true;
    document.getElementById('service-cloud').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('input[name="cloud_tabs"][aria-label="Hugging Face"]').click();
    document.querySelector('#parakeet-hf-form .url-source').open = true;
  });
  const field = await measure(page, '#parakeet-hf-media');
  expect(field.maxWidth).toBe('none');
  expect(field.width).toBeGreaterThan(400);
  expect(field.width).toBeGreaterThanOrEqual(field.parentWidth - 2);
  // every link field in the page carries the same mark, so the paste rule reaches them all
  const marked = await page.evaluate(() => Array.from(document.querySelectorAll('input.media-link')).map((el) => el.id).sort());
  expect(marked).toEqual(['assemblyai-media', 'deepgram-json-media', 'deepgram-media', 'media', 'parakeet-hf-media', 'parakeet-media', 'srt-media', 'vtt-media', 'whisper-json-media']);
  expect(await page.evaluate(() => Array.from(document.querySelectorAll('input.media-link')).every((el) => getComputedStyle(el).maxWidth === 'none'))).toBe(true);
});

test('after a paste the address reads from its start', async ({ page }) => {
  await page.evaluate(() => {
    document.getElementById('file-import-srt-dialog').checked = true;
  });
  const field = page.locator('#srt-media');
  await field.click();
  // the paste as the browser does it: the text lands, the caret sits at its end
  await page.evaluate((text) => {
    const el = document.getElementById('srt-media');
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    if (!event.defaultPrevented) { el.value = text; el.setSelectionRange(text.length, text.length); el.scrollLeft = 10000; }
  }, URL_TEXT);
  await expect.poll(() => page.evaluate(() => {
    const el = document.getElementById('srt-media');
    return { start: el.selectionStart, scroll: el.scrollLeft, value: el.value };
  })).toEqual({ start: 0, scroll: 0, value: URL_TEXT });
  // typing afterwards is not disturbed: only a paste moves the caret
  await page.evaluate(() => { const el = document.getElementById('srt-media'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await page.keyboard.type('?x');
  expect(await field.inputValue()).toBe(URL_TEXT + '?x');
  expect(await page.evaluate(() => document.getElementById('srt-media').selectionStart)).toBe(URL_TEXT.length + 2);
});

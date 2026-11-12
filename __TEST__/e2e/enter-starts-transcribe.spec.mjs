// #802 — Enter in a transcribe tab's URL field used to submit the form
// natively and reload the page: the tabs start through labels, not submit
// buttons, so a form whose only text field is the URL field had nothing to
// stop the browser's implicit submission. Enter now does what the tab's start
// control does, and nothing when that control is disabled.
import { test, expect } from '@playwright/test';

const TABS = [
  { tab: 'Parakeet', field: '#parakeet-media', control: '#parakeet-form-submit-btn' },
  { tab: 'Whisper', field: '#media', control: '#form-submit-btn' },
];

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(() => { document.getElementById('transcribe-modal').checked = true; });
});

// swallow the start control's click at the target, before the engine's own
// listener, so the test sees the hand-over without starting a transcription
async function armClickCounter(page, control) {
  await page.evaluate((sel) => {
    window.__startClicks = 0;
    document.querySelector(sel).addEventListener('click', (e) => {
      window.__startClicks++;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }, control);
}

async function showTab(page, { tab, field }) {
  await page.evaluate(({ tab, field }) => {
    document.querySelector(`input[name="local_tabs"][aria-label="${tab}"]`).checked = true;
    const details = document.querySelector(field).closest('details');
    if (details !== null) details.open = true;
  }, { tab, field });
}

for (const entry of TABS) {
  test(`Enter in the ${entry.tab} URL field starts the transcription instead of reloading (#802)`, async ({ page }) => {
    await showTab(page, entry);
    await armClickCounter(page, entry.control);
    const url = page.url();
    await page.fill(entry.field, 'https://example.com/a.mp4');
    await expect(page.locator(entry.control)).not.toHaveClass(/btn-disabled/);
    await page.press(entry.field, 'Enter');
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => window.__startClicks)).toBe(1);
    await expect(page.locator('#transcribe-modal')).toBeChecked();
  });

  test(`an address without a scheme starts from the ${entry.tab} tab on Enter, with no validation bubble (#802)`, async ({ page }) => {
    await showTab(page, entry);
    await armClickCounter(page, entry.control);
    const url = page.url();
    await page.fill(entry.field, 'example.com/a.mp4');
    await page.press(entry.field, 'Enter');
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => window.__startClicks)).toBe(1);
    // the form opted out of the browser's validation, so the URL type never
    // blocks a submission on its own
    expect(await page.evaluate((sel) => document.querySelector(sel).form.noValidate, entry.field)).toBe(true);
  });
}

test('Enter does nothing while the start control is disabled (#802)', async ({ page }) => {
  const entry = TABS[1];
  await showTab(page, entry);
  await armClickCounter(page, entry.control);
  const url = page.url();
  await page.fill(entry.field, 'https://example.com/a.mp4');
  await page.fill(entry.field, '');
  await expect(page.locator(entry.control)).toHaveClass(/btn-disabled/);
  await page.press(entry.field, 'Enter');
  await page.waitForTimeout(300);
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => window.__startClicks)).toBe(0);
});

test('every transcribe form opts out of the browser validation (#802)', async ({ page }) => {
  const forms = await page.evaluate(() => [...document.querySelectorAll('#transcribe-modal ~ .modal form')].map((f) => f.noValidate));
  expect(forms.length).toBeGreaterThanOrEqual(5);
  expect(forms.every(Boolean)).toBe(true);
});

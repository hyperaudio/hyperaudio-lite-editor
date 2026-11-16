// #799 — Safari saved a transcribe key as a login for the page, with the
// media URL beside it as the username: the key fields are password inputs,
// so each tab's form read as a login form and the nearest text field as the
// username. The forms and the key fields now say they are not for autofill,
// and the URL fields say they are URLs.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('key fields and their forms are not for autofill (#799)', async ({ page }) => {
  // the three transcribe keys; the Ionosphere sign-in is a real login form
  // (handle + app password) and is meant for the password manager
  const keys = await page.evaluate(() => [...document.querySelectorAll('#transcribe-modal ~ .modal input[type="password"]')].map((el) => ({
    id: el.id,
    autocomplete: el.getAttribute('autocomplete'),
    form: el.form === null ? null : el.form.getAttribute('autocomplete'),
  })));
  expect(keys.map((k) => k.id).sort()).toEqual(['assemblyai-key', 'parakeet-hf-key', 'token']);
  keys.forEach((k) => expect(k, k.id).toMatchObject({ autocomplete: 'off', form: 'off' }));
  // every transcribe form, including the two with no key field
  const forms = await page.evaluate(() => [...document.querySelectorAll('#transcribe-modal ~ .modal form, template')]
    .flatMap((el) => (el.content ? [...el.content.querySelectorAll('form')] : [el]))
    .map((f) => f.getAttribute('autocomplete')));
  expect(forms.length).toBeGreaterThanOrEqual(5);
  expect(forms.every((a) => a === 'off')).toBe(true);
});

test('media link fields are URL fields (#799)', async ({ page }) => {
  const links = await page.evaluate(() => {
    const live = [...document.querySelectorAll('input.media-link')];
    const inTemplates = [...document.querySelectorAll('template')].flatMap((t) => [...t.content.querySelectorAll('input.media-link')]);
    return [...live, ...inTemplates].map((el) => ({ id: el.id, type: el.type, autocomplete: el.getAttribute('autocomplete') }));
  });
  const ids = links.map((l) => l.id);
  ['deepgram-media', 'assemblyai-media', 'parakeet-hf-media', 'media', 'parakeet-media'].forEach((id) => expect(ids).toContain(id));
  links.forEach((l) => expect(l, l.id).toMatchObject({ type: 'url', autocomplete: 'url' }));
});

test('a URL field never blocks a start: the transcribe controls are not submit buttons (#799)', async ({ page }) => {
  // type="url" would make a native submission refuse an address without a
  // scheme; the tabs start through labels that close the dialog, so the
  // browser's own validation is never consulted
  const controls = await page.evaluate(() => [...document.querySelectorAll('[data-transcribe-submit]')].map((el) => el.tagName));
  expect(controls.length).toBeGreaterThanOrEqual(4);
  expect(controls.every((t) => t === 'LABEL')).toBe(true);
  expect(await page.evaluate(() => document.querySelectorAll('#transcribe-modal ~ .modal button[type="submit"], #transcribe-modal ~ .modal input[type="submit"]').length)).toBe(0);
});

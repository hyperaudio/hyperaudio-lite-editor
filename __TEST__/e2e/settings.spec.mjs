// #615 — a settings modal for the things that are the user's choice rather
// than the project's, and for undoing choices that could not be undone: a
// gear in the player-controls row opens it; Playback holds the double-click
// preference; Application shows the version and storage, and offers the
// escape hatches (un-dismiss warnings, forget API keys, reset the editor).
import { test, expect } from '@playwright/test';

const openSettings = (page) => page.evaluate(() => {
  const m = document.getElementById('settings-modal');
  m.checked = true;
  m.dispatchEvent(new Event('change'));
});

const rows = (page) => page.evaluate(async () =>
  (await window.HyperaudioSave.library.list()).map((e) => e.name));

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('the gear sits with the icon buttons and opens the modal from the keyboard', async ({ page }) => {
  const r = await page.evaluate(() => {
    const gear = document.getElementById('settings-btn');
    const toggle = document.getElementById('settings-modal');
    const audio = document.getElementById('audio-only-btn').getBoundingClientRect();
    const g = gear.getBoundingClientRect();
    return {
      tabbable: gear.tabIndex === 0,
      wired: gear.dataset.a11yWired === '1',
      toggleHidden: toggle.getAttribute('aria-hidden') === 'true' && toggle.tabIndex === -1,
      sameRow: Math.abs(g.top - audio.top) < 1 && g.height === audio.height,
      rightOfAudioOnly: g.left > audio.right,
      leftOfSpeakers: g.right < document.querySelector('label[for="show-speakers"]').getBoundingClientRect().left,
    };
  });
  expect(r).toEqual({ tabbable: true, wired: true, toggleHidden: true, sameRow: true, rightOfAudioOnly: true, leftOfSpeakers: true });
  await page.focus('#settings-btn');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.getElementById('settings-modal').checked)).toBe(true);
  // the version meta, and the release date when the release commit has set it
  await expect(page.locator('#settings-app-version')).toHaveText(/^v\d+\.\d+\.\d+ · (unreleased|.*\b\d{4})$/);   // the date is locale-formatted
  await expect(page.locator('#settings-storage')).toHaveText(/Using .+ of the .+ this browser allows/);
});

test('double-click to play is off by default, takes effect live, and survives a reload', async ({ page }) => {
  const stubPlay = () => page.evaluate(() => {
    window.__played = 0;
    document.getElementById('hyperplayer').play = () => { window.__played += 1; return Promise.resolve(); };
  });
  const word = '#hypertranscript span[data-m]:nth-of-type(3)';

  expect(await page.evaluate(() => window.hyperaudioInstance.playOnClick)).toBe(false);
  await stubPlay();
  await page.dblclick(word);
  expect(await page.evaluate(() => window.__played)).toBe(0);   // moved the playhead, did not play

  await openSettings(page);
  await page.click('label[for="setting-play-on-dblclick"]');
  expect(await page.evaluate(() => ({
    live: window.hyperaudioInstance.playOnClick,
    stored: JSON.parse(localStorage.getItem('hyperaudioSettings')).playOnDoubleClick,
  }))).toEqual({ live: true, stored: true });
  await page.evaluate(() => { document.getElementById('settings-modal').checked = false; });
  await page.dblclick(word);
  expect(await page.evaluate(() => window.__played)).toBeGreaterThan(0);

  // the instance is rebuilt on every transcript load; the stored value must win
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  expect(await page.evaluate(() => ({
    live: window.hyperaudioInstance.playOnClick,
    toggle: document.getElementById('setting-play-on-dblclick').checked,
  }))).toEqual({ live: true, toggle: true });
});

test('a dismissed warning can be brought back', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('noCaptionAlert', 'true'));   // "don't tell me again" (#506)
  await openSettings(page);
  await expect(page.locator('#settings-undismiss')).toBeEnabled();
  await expect(page.locator('#settings-undismiss-hint')).toHaveText('One is hidden.');
  await page.click('#settings-undismiss');
  expect(await page.evaluate(() => localStorage.getItem('noCaptionAlert'))).toBeNull();
  await expect(page.locator('#settings-undismiss')).toBeDisabled();
  await expect(page.locator('#settings-undismiss-hint')).toHaveText('None dismissed.');
});

test('remembered API keys are forgotten in one press, fields and toggles included', async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem('hyperaudioTranscribePrefs', JSON.stringify({
      values: { token: 'dg-secret', 'assemblyai-key': 'aai-secret', 'parakeet-hf-key': 'hf-secret' },
      checks: { 'deepgram-remember-key': true, 'assemblyai-remember-key': true, 'parakeet-hf-remember-key': true },
    }));
  });
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(() => document.getElementById('token').value)).toBe('dg-secret');

  await openSettings(page);
  await expect(page.locator('#settings-forget-keys')).toBeEnabled();
  await page.click('#settings-forget-keys');
  const after = await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('hyperaudioTranscribePrefs'));
    const vals = prefs.values || {};
    return {
      storedKeys: ['token', 'assemblyai-key', 'parakeet-hf-key'].filter((k) => k in vals),
      fields: ['token', 'assemblyai-key', 'parakeet-hf-key'].map((k) => document.getElementById(k).value),
      remember: ['deepgram-remember-key', 'assemblyai-remember-key', 'parakeet-hf-remember-key'].map((k) => document.getElementById(k).checked),
    };
  });
  expect(after).toEqual({ storedKeys: [], fields: ['', '', ''], remember: [false, false, false] });
  await expect(page.locator('#settings-forget-keys')).toBeDisabled();
});

test('downloaded models are listed by name and removed one at a time, leaving projects alone', async ({ page }) => {
  // the engines declare their caches and name their models; settings knows none by name
  const declared = await page.evaluate(() => window.HyperaudioModelStores.map((s) => s.engine + ':' + s.cacheName + ':' + typeof s.label).sort());
  expect(declared).toEqual(['Parakeet:parakeet-models-v1:function', 'Whisper:transformers-cache:function']);

  await openSettings(page);
  await expect(page.locator('#settings-models-hint')).toHaveText('None downloaded.');
  await expect(page.locator('#settings-models li')).toHaveCount(0);

  // "downloads": Parakeet's files plus a length sidecar, and two Whisper
  // models under their Hugging Face repo paths — one entry without a length
  await page.evaluate(async () => {
    const put = async (cacheName, url, bytes, declare) => {
      const cache = await caches.open(cacheName);
      const headers = declare ? { 'content-length': String(bytes) } : {};
      await cache.put(new Request(url), new Response(new Uint8Array(bytes), { headers }));
    };
    await put('parakeet-models-v1', 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.onnx', 3 * 1e6, true);
    await put('parakeet-models-v1', 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.onnx.len', 8, true);
    await put('transformers-cache', 'https://huggingface.co/onnx-community/whisper-small.en_timestamped/resolve/main/onnx/encoder_model.onnx', 2 * 1e6, false);
    await put('transformers-cache', 'https://huggingface.co/onnx-community/whisper-small.en_timestamped/resolve/main/config.json', 1e3, true);
    await put('transformers-cache', 'https://huggingface.co/onnx-community/whisper-large-v3-turbo_timestamped/resolve/main/onnx/decoder_model.onnx', 1e6, true);
    // from before the June 2026 lineup, and the runtime transformers.js caches alongside
    await put('transformers-cache', 'https://huggingface.co/Xenova/whisper-tiny.en/resolve/main/onnx/encoder_model_quantized.onnx', 5e5, true);
    await put('transformers-cache', 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/ort-wasm-simd-threaded.jsep.wasm', 2e5, true);
  });
  await page.evaluate(() => window.HyperaudioSettings.refresh());
  const lines = () => page.evaluate(() => [...document.querySelectorAll('#settings-models li')].map((li) => li.textContent.trim().replace(/\s+/g, ' ')));
  // the runtime is counted in the total (200 kB of the 7 MB) but is not a
  // line: nothing to manage there
  await expect.poll(lines).toEqual([
    'Parakeet TDT 0.6B v3 · multilingual3 MBRemove',
    'Whisper small · English2 MBRemove',
    'Whisper tiny · English500 kBRemove',
    'Whisper turbo · multilingual1 MBRemove',
  ]);
  await expect(page.locator('#settings-models-hint')).toHaveText(/7 MB in all/);

  // one Whisper model goes; the other, and Parakeet, stay
  await page.click('button[aria-label="Remove Whisper small · English"]');
  await expect.poll(lines).toEqual([
    'Parakeet TDT 0.6B v3 · multilingual3 MBRemove',
    'Whisper tiny · English500 kBRemove',
    'Whisper turbo · multilingual1 MBRemove',
  ]);
  expect(await page.evaluate(async () => (await (await caches.open('transformers-cache')).keys()).map((r) => r.url).sort())).toEqual([
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/ort-wasm-simd-threaded.jsep.wasm',
    'https://huggingface.co/Xenova/whisper-tiny.en/resolve/main/onnx/encoder_model_quantized.onnx',
    'https://huggingface.co/onnx-community/whisper-large-v3-turbo_timestamped/resolve/main/onnx/decoder_model.onnx',
  ]);

  await page.click('button[aria-label="Remove Whisper turbo · multilingual"]');
  // the runtime files go with the last model — the cache is deleted whole
  await page.click('button[aria-label="Remove Whisper tiny · English"]');
  await expect.poll(() => page.evaluate(() => caches.has('transformers-cache'))).toBe(false);
  await page.click('button[aria-label="Remove Parakeet TDT 0.6B v3 · multilingual"]');
  await expect(page.locator('#settings-models-hint')).toHaveText('None downloaded.');
  await expect(page.locator('#settings-models li')).toHaveCount(0);
  // an emptied cache is gone, not left as an empty shell
  expect(await page.evaluate(async () => [await caches.has('parakeet-models-v1'), await caches.has('transformers-cache')])).toEqual([false, false]);
  await expect.poll(() => rows(page)).toEqual(['How to use the Editor']);   // projects untouched
});

test('reset asks first, keeps everything on cancel, and brings the intro back on confirm (#602)', async ({ page }) => {
  await expect.poll(() => rows(page)).toEqual(['How to use the Editor']);
  // the state a reset exists for: the intro deleted (permanent by design),
  // a dismissed warning, a preference
  await page.evaluate(async () => {
    const lib = window.HyperaudioSave.library;
    await lib.remove(lib.currentId());
    localStorage.setItem('noCaptionAlert', 'true');
    window.HyperaudioSettings.set('playOnDoubleClick', true);
  });
  await expect.poll(() => rows(page)).toEqual([]);

  await openSettings(page);
  await page.click('#settings-reset');
  await expect(page.locator('#project-dialog-title-text')).toHaveText('Reset the editor?');
  await page.click('#project-dialog-cancel');
  expect(await page.evaluate(() => localStorage.getItem('noCaptionAlert'))).toBe('true');
  await expect.poll(() => rows(page)).toEqual([]);

  await page.click('#settings-reset');
  await expect(page.locator('#project-dialog-confirm')).toHaveText('Reset everything');
  await Promise.all([
    page.waitForEvent('load'),
    page.click('#project-dialog-confirm'),
  ]);
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => rows(page)).toEqual(['How to use the Editor']);
  expect(await page.evaluate(() => ({
    dismissed: localStorage.getItem('noCaptionAlert'),
    settings: localStorage.getItem('hyperaudioSettings'),
    playOnClick: window.hyperaudioInstance.playOnClick,
  }))).toEqual({ dismissed: null, settings: null, playOnClick: false });
});

// #763 — what a failed transcription leaves behind. The error card has the
// screen, so no project owns it: the previous project's row no longer lights
// up as if the error were its, and its lock is let go. The advice on the
// card fits the step that failed: nothing to add when the media could not be
// read, "could not be downloaded" when the model's files did not arrive.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ladderWav } from './helpers.mjs';

const DEAD_URL = 'https://dead.example.com/items/clip.mp3';

const startWhisperFromUrl = (page, url) => page.evaluate((url) => {
  const field = document.querySelector('#media');
  field.value = url;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#form-submit-btn').click();
  // the submit label toggles the dialog, which was closed: closed again
  document.getElementById('transcribe-modal').checked = false;
}, url);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await expect.poll(() => page.evaluate(() => window.HyperaudioSave.library.currentId())).not.toBeNull();
});

test('a URL that cannot be read leaves no project selected, and no advice about the model', async ({ page, context }) => {
  test.setTimeout(90000);
  await context.route('**/js/whisper.worker.js*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await page.route(DEAD_URL, () => { /* never answered */ });
  const before = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await startWhisperFromUrl(page, DEAD_URL);
  // the loader row is the selection while it runs
  await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveClass(/active/);
  await expect(page.locator('#file-picker .file-item[data-id].active')).toHaveCount(0);

  const card = page.locator('#hypertranscript');
  await expect(card).toContainText('network error', { timeout: 40000 });
  await expect(card).not.toContainText('smaller model');
  await expect(card).not.toContainText('reload the page');
  // the error card owns the screen: the previous project's row stays unlit,
  // the loader row is gone, and the session points at nothing
  await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveCount(0);
  await expect(page.locator('#file-picker .file-item.active')).toHaveCount(0);
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBeNull();
  // and that project opens again from Recents, whole
  await page.locator(`#file-picker .file-item[data-id="${before}"]`).click();
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(before);
});

test('an error arriving after the user has moved to a project leaves that project selected', async ({ page, context }) => {
  test.setTimeout(90000);
  await context.route('**/js/whisper.worker.js*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await page.route(DEAD_URL, () => { /* never answered */ });
  const id = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await startWhisperFromUrl(page, DEAD_URL);
  await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveClass(/active/);
  // back to the project while the engine waits on the host
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), id);
  await expect(page.locator('#file-picker .file-item[data-id].active')).toHaveCount(1);
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();

  // the error ends the loader row, and nothing else changes on screen: the
  // card is not painted over the project, the corner notice says what it
  // would have said
  await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveCount(0, { timeout: 40000 });
  await expect(page.locator('#file-picker .file-item[data-id].active')).toHaveCount(1);
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(id);
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();
  await expect(page.locator('#hypertranscript')).not.toContainText('Transcription failed');
  await expect(page.locator('#transcript-ready-notice')).toContainText('“clip.mp3” was not transcribed. Could not fetch the media');
  // and the engine is free for the next run
  expect(await page.evaluate(() => document.documentElement.classList.contains('ha-transcribing'))).toBe(false);
});

test('a model whose files cannot be downloaded says so, not that a smaller one might work', async ({ page, context }, testInfo) => {
  // every request to the model host refused, the way a dead connection or a
  // rate limit reaches the page: a fetch that fails, with no status to read
  await context.route('https://huggingface.co/**', (route) => route.abort());
  const wavPath = testInfo.outputPath('tone.wav');
  (await import('node:fs')).writeFileSync(wavPath, ladderWav(2));
  await page.setInputFiles('#file-input', wavPath);
  await page.evaluate(() => document.getElementById('form-submit-btn').click());
  const card = page.locator('#hypertranscript');
  await expect(card).toContainText('Transcription failed', { timeout: 60000 });
  await expect(card).toContainText('could not be downloaded');
  await expect(card).not.toContainText('smaller model');
  await expect(page.locator('#file-picker .file-item.active')).toHaveCount(0);
});

// #764 — the cloud engines painted their error cards straight into the
// transcript, so none of the above reached them. Each failure is the API's
// own refusal, routed, with the media host never answering the player.
const CLOUD = {
  deepgram: {
    api: 'https://api.deepgram.com/**', media: 'https://dg.example.com/items/clip.mp3',
    start: () => {
      document.querySelector('#token').value = 'not-a-token';
      document.querySelector('#deepgram-media').value = 'https://dg.example.com/items/clip.mp3';
      document.querySelector('deepgram-service').getData();
    },
    says: 'the token is invalid',
  },
  assemblyai: {
    api: 'https://api.assemblyai.com/**', media: 'https://aai.example.com/items/clip.mp3',
    start: () => {
      document.querySelector('#assemblyai-key').value = 'not-a-key';
      document.querySelector('#assemblyai-media').value = 'https://aai.example.com/items/clip.mp3';
      document.querySelector('assemblyai-service').getData();
    },
    says: 'The API key appears to be invalid',
  },
  'parakeet-hf': {
    api: 'https://router.huggingface.co/**', media: 'https://hf.example.com/items/clip.mp3',
    start: () => {
      document.querySelector('#parakeet-hf-key').value = 'hf_not-a-token';
      document.querySelector('#parakeet-hf-media').value = 'https://hf.example.com/items/clip.mp3';
      document.querySelector('parakeet-hf-service').getData();
    },
    says: 'The Hugging Face token appears to be invalid',
  },
};

for (const [engine, cloud] of Object.entries(CLOUD)) {
  test(`${engine}: a refused request leaves no project selected (#764)`, async ({ page, context }) => {
    // the refusal takes a moment, long enough for the loader row to be seen
    await context.route(cloud.api, async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
    });
    if (engine === 'parakeet-hf') {
      // this engine fetches the media itself and forwards it, so the host answers
      await page.route(cloud.media, (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: ladderWav(1) }));
    } else {
      await page.route(cloud.media, () => { /* never answered */ });
    }
    const before = await page.evaluate(() => window.HyperaudioSave.library.currentId());
    await page.evaluate(cloud.start);
    await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveClass(/active/);

    const card = page.locator('#hypertranscript');
    await expect(card).toContainText(cloud.says, { timeout: 20000 });
    await expect(card.locator('[data-transcript-notice]')).toHaveCount(1);
    await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveCount(0);
    await expect(page.locator('#file-picker .file-item.active')).toHaveCount(0);
    expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBeNull();
    expect(await page.evaluate(() => document.documentElement.classList.contains('ha-transcribing'))).toBe(false);
    // and that project opens again from Recents, whole
    await page.locator(`#file-picker .file-item[data-id="${before}"]`).click();
    await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();
    expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(before);
  });
}

test('a cloud refusal arriving after the user has moved to a project becomes a notice, not a card (#764)', async ({ page, context }) => {
  const cloud = CLOUD.assemblyai;
  await context.route(cloud.api, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
  });
  await page.route(cloud.media, () => { /* never answered */ });
  const id = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await page.evaluate(cloud.start);
  await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveClass(/active/);
  // back to the project while the API thinks it over
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), id);
  await expect(page.locator('#file-picker .file-item[data-id].active')).toHaveCount(1);
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();

  await expect(page.locator('#file-picker .recents-transcribing-item')).toHaveCount(0, { timeout: 20000 });
  await expect(page.locator('#file-picker .file-item[data-id].active')).toHaveCount(1);
  expect(await page.evaluate(() => window.HyperaudioSave.library.currentId())).toBe(id);
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible();
  await expect(page.locator('#hypertranscript')).not.toContainText('API key');
  await expect(page.locator('#transcript-ready-notice')).toContainText('“clip.mp3” was not transcribed. The API key appears to be invalid');
  expect(await page.evaluate(() => document.documentElement.classList.contains('ha-transcribing'))).toBe(false);
});

// The Hugging Face router's codes too (#777): no credit on the account, and a
// model the provider has withdrawn, which is how the Parakeet engine died
for (const [status, says] of [[402, 'no credit for Inference Providers'], [410, 'no longer serves this model']]) {
  test(`nemotron (hf): a ${status} says what that code means (#777)`, async ({ page, context }) => {
    const cloud = CLOUD['parakeet-hf'];
    await context.route(cloud.api, (route) => route.fulfill({ status, contentType: 'application/json', body: '{"error":"x"}' }));
    await page.route(cloud.media, (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: ladderWav(1) }));
    await page.evaluate(cloud.start);
    const card = page.locator('#hypertranscript');
    await expect(card).toContainText(says, { timeout: 20000 });
    await expect(card).not.toContainText('unexpected error');
    await expect(card).not.toContainText('token appears to be invalid');
    await expect(page.locator('#file-picker .file-item.active')).toHaveCount(0);
  });
}

test('nemotron (hf): the request goes to a provider that takes credits and names the model as it knows it (#777)', async ({ page, context }) => {
  const cloud = CLOUD['parakeet-hf'];
  let model = null;
  let url = null;
  await context.route(cloud.api, async (route) => {
    url = route.request().url();
    const body = route.request().postDataBuffer();
    const text = body ? body.toString('latin1') : '';
    const m = /name="model"\r\n\r\n([^\r\n]+)/.exec(text);
    model = m ? m[1] : null;
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"x"}' });
  });
  await page.route(cloud.media, (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: ladderWav(1) }));
  await page.evaluate(cloud.start);
  await expect(page.locator('#hypertranscript')).toContainText('token appears to be invalid', { timeout: 20000 });
  // DeepInfra's own id: the router does not map the Hub's id on this route
  expect(model).toBe('nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B');
  expect(url).toBe('https://router.huggingface.co/deepinfra/v1/openai/audio/transcriptions');
});

// The tab offers three models on the one route (#777). The chosen one is what
// goes on the wire, the Language list follows the model, and a remembered
// model comes back with its language after a reload.
test('hugging face: the chosen model and language go on the wire, and the choice is remembered', async ({ page, context }) => {
  const cloud = CLOUD['parakeet-hf'];
  const posted = [];
  await context.route(cloud.api, async (route) => {
    const text = (route.request().postDataBuffer() || Buffer.alloc(0)).toString('latin1');
    const field = (name) => { const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]+)`).exec(text); return m ? m[1] : null; };
    posted.push({ model: field('model'), language: field('language') });
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"x"}' });
  });
  await page.route(cloud.media, (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: ladderWav(1) }));

  const lists = await page.evaluate(() => {
    const model = document.querySelector('#parakeet-hf-model');
    const lang = document.querySelector('#parakeet-hf-language');
    const codes = () => Array.from(lang.options).map((o) => o.value);
    const out = { models: Array.from(model.options).map((o) => o.value), nemotron: codes() };
    model.value = 'Qwen/Qwen3-ASR-1.7B';
    model.dispatchEvent(new Event('change', { bubbles: true }));
    out.qwen = codes();
    model.value = 'openai/whisper-large-v3-turbo';
    model.dispatchEvent(new Event('change', { bubbles: true }));
    out.whisper = codes();
    lang.value = 'cy';
    lang.dispatchEvent(new Event('change', { bubbles: true }));
    return out;
  });
  expect(lists.models).toEqual(['nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B', 'openai/whisper-large-v3-turbo', 'Qwen/Qwen3-ASR-1.7B']);
  expect(lists.nemotron.length).toBe(41);
  expect(lists.nemotron).toContain('ta');
  expect(lists.nemotron).not.toContain('cy');
  expect(lists.qwen).toEqual(['auto']); // Qwen detects on its own, whatever it is told
  expect(lists.whisper).toContain('cy');

  await page.evaluate(cloud.start);
  await expect(page.locator('#hypertranscript')).toContainText('token appears to be invalid', { timeout: 20000 });
  expect(posted).toEqual([{ model: 'openai/whisper-large-v3-turbo', language: 'cy' }]);

  // remembered: the model first, then the language it offers (#777)
  await page.reload();
  await page.waitForSelector('#parakeet-hf-model option', { state: 'attached' });
  await expect.poll(() => page.evaluate(() => document.querySelector('#parakeet-hf-model').value)).toBe('openai/whisper-large-v3-turbo');
  expect(await page.evaluate(() => document.querySelector('#parakeet-hf-language').value)).toBe('cy');
});

// Deepgram's status codes each mean one thing, and the card says that one
// thing rather than hedging between a bad link and a bad key (#764)
for (const [status, says] of [[400, 'The media could not be read'], [402, 'no credit left'], [403, 'no access to the chosen model']]) {
  test(`deepgram: a ${status} says what that code means`, async ({ page, context }) => {
    const cloud = CLOUD.deepgram;
    await context.route(cloud.api, (route) => route.fulfill({ status, contentType: 'application/json', body: '{"err_code":"x"}' }));
    await page.route(cloud.media, () => { /* never answered */ });
    await page.evaluate(cloud.start);
    const card = page.locator('#hypertranscript');
    await expect(card).toContainText(says, { timeout: 20000 });
    await expect(card).not.toContainText('token is invalid');
    await expect(page.locator('#file-picker .file-item.active')).toHaveCount(0);
  });
}

// A cloud run bills by the minute of audio and the answer carries no cost, so
// the info panel estimates it from the audio length the service reported and
// the rate the engine knows, live and again for the reopened project.
test('hugging face: a finished run shows its estimated cost, and the reopened project keeps it', async ({ page, context }) => {
  const cloud = CLOUD['parakeet-hf'];
  const answer = readFileSync(new URL('../fixtures/converters/nemotron.json', import.meta.url), 'utf8');
  await context.route(cloud.api, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: answer }));
  await page.route(cloud.media, (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: ladderWav(1) }));
  await page.evaluate(cloud.start);
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible({ timeout: 20000 });
  const info = page.locator('#transcription-info');
  await expect(info).toContainText('Model: Nemotron 3.5 Transcribe 30B');
  // 64.125 s at $0.002 a minute
  await expect(info).toContainText('Estimated cost: $0.0021 ($0.002 per minute of audio)');

  // the project keeps it: audio length and rate are in its provenance
  await page.waitForFunction(() => window.HyperaudioSave.library.currentId() !== null);
  const id = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await page.waitForTimeout(1500); // the autosave
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), id);
  await expect(info).toContainText('Estimated cost: $0.0021 ($0.002 per minute of audio)', { timeout: 15000 });
  const provenance = await page.evaluate(() => window.HyperaudioSave.getProvenance());
  expect(provenance).toMatchObject({ audioSeconds: 64.125, rateUsdPerMinute: 0.002, modelId: 'nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B' });
});

// Only Deepgram writes the summary and the topics, so a project born from any
// other engine kept the previous project's, saved them and showed them in its
// info panel as its own. The loader taking the screen clears them.
test('hugging face: the new project does not inherit the previous project\'s summary and topics', async ({ page, context }) => {
  const cloud = CLOUD['parakeet-hf'];
  const answer = readFileSync(new URL('../fixtures/converters/nemotron.json', import.meta.url), 'utf8');
  await context.route(cloud.api, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: answer }));
  await page.route(cloud.media, (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: ladderWav(1) }));
  // the open project has a summary and topics of its own, saved
  const homeId = await page.evaluate(async () => {
    document.getElementById('summary').textContent = 'A talk about tides.';
    document.getElementById('topics').textContent = 'Tides, Moon';
    await window.HyperaudioSave.saveProject();
    return window.HyperaudioSave.library.currentId();
  });
  await page.evaluate(cloud.start);
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible({ timeout: 20000 });
  await page.waitForFunction((home) => window.HyperaudioSave.library.currentId() !== null && window.HyperaudioSave.library.currentId() !== home, homeId);
  expect(await page.evaluate(() => [document.getElementById('summary').textContent, document.getElementById('topics').textContent])).toEqual(['', '']);
  const bornId = await page.evaluate(() => window.HyperaudioSave.library.currentId());
  await page.waitForTimeout(1500); // the autosave
  const entries = await page.evaluate(() => window.HyperaudioSave.library.list());
  const born = entries.find((e) => String(e.id) === String(bornId));
  expect(born.summary || '').toBe('');
  expect(born.topics || []).toEqual([]);
  // and the previous project still has its own
  await page.evaluate((id) => window.HyperaudioSave.library.open(id), homeId);
  await expect(page.locator('#summary')).toHaveText('A talk about tides.');
  await expect(page.locator('#topics')).toHaveText('Tides, Moon');
});

// The one key field also takes a DeepInfra API key (#760). A Hugging Face
// token begins hf_, so any other key goes to DeepInfra itself: the same body
// to its OpenAI-compatible route, or, with "Label speakers" on and Nemotron
// chosen, to its own route for the model, which puts a speaker on every word.
// The fixture is that route's real answer for a 41 s clip of two voices
// taking six turns.
const DEEPINFRA_START = ({ model, speakers }) => {
  const key = document.querySelector('#parakeet-hf-key');
  key.value = 'di-secret-key';
  key.dispatchEvent(new Event('input', { bubbles: true }));
  const modelSel = document.querySelector('#parakeet-hf-model');
  modelSel.value = model;
  modelSel.dispatchEvent(new Event('change', { bubbles: true }));
  const toggle = document.querySelector('#parakeet-hf-speakers');
  toggle.checked = speakers;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('#parakeet-hf-media').value = 'https://hf.example.com/items/clip.mp3';
  document.querySelector('parakeet-hf-service').getData();
};

test('deepinfra key: nemotron with speakers goes to DeepInfra\'s own route, and the transcript has speaker paragraphs', async ({ page, context }) => {
  const cloud = CLOUD['parakeet-hf'];
  const answer = readFileSync(new URL('../fixtures/converters/nemotron-speakers.json', import.meta.url), 'utf8');
  const posted = [];
  await context.route('https://api.deepinfra.com/**', async (route) => {
    const text = (route.request().postDataBuffer() || Buffer.alloc(0)).toString('latin1');
    const field = (name) => { const m = new RegExp(`name="${name}"(?:; filename="[^"]*")?\\r\\n(?:[^\\r\\n]*\\r\\n)?\\r\\n([^\\r\\n]*)`).exec(text); return m ? m[1] : null; };
    posted.push({ url: route.request().url(), auth: route.request().headers().authorization, hasAudio: /name="audio"; filename=/.test(text), hasFile: /name="file"; filename=/.test(text), chunk_level: field('chunk_level'), diarize: field('diarize'), model: field('model') });
    await route.fulfill({ status: 200, contentType: 'application/json', body: answer });
  });
  await page.route(cloud.media, (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: ladderWav(1) }));

  // the toggle is offered for a DeepInfra key with Nemotron, and only then
  const offered = await page.evaluate(() => {
    const row = document.querySelector('#parakeet-hf-speakers-row');
    const key = document.querySelector('#parakeet-hf-key');
    const modelSel = document.querySelector('#parakeet-hf-model');
    const set = (k, m) => { key.value = k; key.dispatchEvent(new Event('input', { bubbles: true })); modelSel.value = m; modelSel.dispatchEvent(new Event('change', { bubbles: true })); return getComputedStyle(row).display; };
    return {
      hfNemotron: set('hf_abc', 'nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B'),
      diWhisper: set('di-secret-key', 'openai/whisper-large-v3-turbo'),
      diNemotron: set('di-secret-key', 'nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B'),
      empty: set('', 'nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B'),
    };
  });
  expect(offered).toEqual({ hfNemotron: 'none', diWhisper: 'none', diNemotron: 'flex', empty: 'none' });

  await page.evaluate(DEEPINFRA_START, { model: 'nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B', speakers: true });
  await expect(page.locator('#hypertranscript [data-m]').first()).toBeVisible({ timeout: 20000 });
  expect(posted).toEqual([{
    url: 'https://api.deepinfra.com/v1/inference/nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B',
    auth: 'Bearer di-secret-key', hasAudio: true, hasFile: false, chunk_level: 'word', diarize: 'true', model: null,
  }]);
  // a label where each speaker starts, once per run of one speaker, and a paragraph at every change
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll('#hypertranscript .speaker')).map((s) => s.textContent.trim()));
  expect(labels).toEqual(['[speaker-0]', '[speaker-1]', '[speaker-0]', '[speaker-1]', '[speaker-0]', '[speaker-1]']);
  const firstWords = await page.evaluate(() => Array.from(document.querySelectorAll('#hypertranscript p')).map((p) => p.querySelector('[data-m]:not(.speaker)').textContent.trim()));
  ["Good", "Thanks", "So", "Exactly,", "That", "It"].forEach((word) => expect(firstWords).toContain(word));   // each turn opens a paragraph
  const info = page.locator('#transcription-info');
  await expect(info).toContainText('Service: DeepInfra (cloud)');
  // 41.4 s at $0.002 a minute (the route also reports duration, and input_length_ms is the fallback)
  await expect(info).toContainText('Estimated cost: $0.0014 ($0.002 per minute of audio)');
  await page.waitForFunction(() => window.HyperaudioSave.library.currentId() !== null);
  const provenance = await page.evaluate(() => window.HyperaudioSave.getProvenance());
  expect(provenance).toMatchObject({ engine: 'deepinfra (cloud)', audioSeconds: 41.398, modelId: 'nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B' });
  expect(provenance.parameters).toMatchObject({ chunk_level: 'word', diarize: true });

  // the toggle is remembered with the key
  await page.reload();
  await page.waitForSelector('#parakeet-hf-model option', { state: 'attached' });
  await expect.poll(() => page.evaluate(() => [document.querySelector('#parakeet-hf-speakers').checked, getComputedStyle(document.querySelector('#parakeet-hf-speakers-row')).display])).toEqual([true, 'flex']);
});

test('deepinfra key: whisper goes to DeepInfra\'s OpenAI route, and a refusal names the key', async ({ page, context }) => {
  const cloud = CLOUD['parakeet-hf'];
  const posted = [];
  await context.route('https://api.deepinfra.com/**', async (route) => {
    const text = (route.request().postDataBuffer() || Buffer.alloc(0)).toString('latin1');
    posted.push({ url: route.request().url(), model: (/name="model"\r\n\r\n([^\r\n]+)/.exec(text) || [])[1], diarize: /name="diarize"/.test(text) });
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"invalid api key"}' });
  });
  let routerCalls = 0;
  await context.route(cloud.api, (route) => { routerCalls += 1; return route.fulfill({ status: 500, body: '' }); });
  await page.route(cloud.media, (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: ladderWav(1) }));
  await page.evaluate(DEEPINFRA_START, { model: 'openai/whisper-large-v3-turbo', speakers: true });
  await expect(page.locator('#hypertranscript')).toContainText('The DeepInfra API key appears to be invalid', { timeout: 20000 });
  expect(posted).toEqual([{ url: 'https://api.deepinfra.com/v1/openai/audio/transcriptions', model: 'openai/whisper-large-v3-turbo', diarize: false }]);
  expect(routerCalls).toBe(0);
});

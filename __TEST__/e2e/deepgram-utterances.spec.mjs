// Deepgram's `diarize` tags each word on its own, so a speaker boundary lands
// a few words short of where the turn ended and the next speaker is credited
// with the tail of the previous one's sentence — the label then reads as
// mid-sentence. `utterances` gives segments cut on pauses and turns, each with
// one speaker, which is the same kind of data AssemblyAI returns and why its
// labels land cleanly. Speakers are taken from those, matched by time.
import { test, expect } from '@playwright/test';

// The real shape of the fault, from a six-way debate: the speaker flag flips
// four words before the sentence ends, so "as well if you tap into that
// potential" is credited to the next speaker.
const SAID = [
  ['We', 0], ['could', 0], ['be', 0], ['there', 0], ['at', 0], ['the', 0],
  ['start', 0], ['of', 0], ['this', 0], ['new', 0], ['industrial', 0], ['revolution', 0],
  ['as', 0], ['well', 1], ['if', 1], ['you', 1], ['tap', 1], ['into', 1], ['that', 1], ['potential.', 1],
  ['There', 1], ['has', 1], ['to', 1], ['be', 1], ['more.', 1],
];
const words = SAID.map(([word, speaker], i) => ({
  word: word.toLowerCase().replace(/[.,]/g, ''),
  punctuated_word: word,
  start: Number((i * 0.3).toFixed(2)),
  end: Number((i * 0.3 + 0.25).toFixed(2)),
  speaker,
}));
// what utterances says: speaker 0 holds the whole first sentence, speaker 1
// begins at "There"
const utterances = [
  { speaker: 0, start: 0, end: words[19].end, transcript: 'We could be there…potential.' },
  { speaker: 1, start: words[20].start, end: words[24].end, transcript: 'There has to be more.' },
];

const respond = (page, body) => page.route('https://api.deepgram.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));

const shape = (extra) => ({
  results: Object.assign({
    channels: [{ detected_language: 'en', alternatives: [{ transcript: SAID.map((s) => s[0]).join(' '), words }] }],
  }, extra),
});

const transcribe = (page) => page.evaluate(() => {
  document.getElementById('transcribe-modal').checked = true;
  document.querySelector('#token').value = 'test-token';
  const media = document.querySelector('#deepgram-media');
  media.value = 'https://example.com/debate.mp4';
  media.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#transcribe-btn').click();
});

// each paragraph as "[speaker-N] its words"
const paragraphs = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#hypertranscript p')].map((p) =>
    [...p.querySelectorAll('span[data-m]')].map((s) => s.textContent.trim()).join(' ')));

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('the speaker label lands where the turn ends, not four words early', async ({ page }) => {
  await respond(page, shape({ utterances }));
  await transcribe(page);
  await expect.poll(() => paragraphs(page).then((p) => p.length)).toBe(2);

  const paras = await paragraphs(page);
  expect(paras[0]).toBe('[speaker-0] We could be there at the start of this new industrial revolution as well if you tap into that potential.');
  expect(paras[1]).toBe('[speaker-1] There has to be more.');

  // the request asked for them in the first place
  const asked = await page.evaluate(() => performance.getEntriesByType('resource')
    .some((e) => e.name.includes('api.deepgram.com') && e.name.includes('utterances=true')));
  expect(asked).toBe(true);
});

test('a response without utterances keeps the per-word flags, and still works', async ({ page }) => {
  await respond(page, shape({}));
  await transcribe(page);
  await expect.poll(() => paragraphs(page).then((p) => p.length)).toBe(2);

  // unchanged behaviour: the boundary is where Deepgram put it, mid-sentence
  const paras = await paragraphs(page);
  expect(paras[0]).toBe('[speaker-0] We could be there at the start of this new industrial revolution as');
  expect(paras[1].startsWith('[speaker-1] well if you tap into that potential.')).toBe(true);
});

test('a word in no utterance keeps the speaker it had', async ({ page }) => {
  // a gap in the utterance list: the words between are left alone rather than
  // swept into whichever segment happens to be nearest
  const gapped = [Object.assign({}, utterances[0], { end: words[10].end }), utterances[1]];
  await respond(page, shape({ utterances: gapped }));
  await transcribe(page);
  await expect.poll(() => paragraphs(page).then((p) => p.length)).toBeGreaterThan(1);

  const paras = await paragraphs(page);
  // "revolution as" kept speaker 0 from its own flag; "well…" kept speaker 1
  expect(paras[0]).toBe('[speaker-0] We could be there at the start of this new industrial revolution as');
  expect(paras[1].startsWith('[speaker-1] well if')).toBe(true);
});

test('the report says which source the speakers came from', async ({ page }) => {
  await respond(page, shape({ utterances }));
  await transcribe(page);
  await expect.poll(() => paragraphs(page).then((p) => p.length)).toBe(2);
  const report = await page.evaluate(() => window.hyperaudioSpeakerDebug());
  expect(report.speakersFrom).toBe('utterances');
  expect(report.utterances).toBe(2);
  expect(report.changesMidSentence).toBe(0);
});

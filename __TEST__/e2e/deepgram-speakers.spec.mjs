// Deepgram's speaker boundaries are reproduced exactly as they report them.
// Two attempts to correct their mid-sentence placement were tried against a
// six-way debate and both failed — taking speakers from `utterances` merged
// distinct people, and snapping changes onto utterance edges moved sixteen of
// them and changed nothing visible. This pins the decision: the parser draws
// what Deepgram says, and anything that starts quietly editing their speakers
// again has to come past this test.
import { test, expect } from '@playwright/test';

const SAID = [
  ['We', 0], ['could', 0], ['be', 0], ['there', 0], ['at', 0], ['the', 0],
  ['start', 0], ['of', 0], ['this', 0], ['new', 0], ['industrial', 0], ['revolution', 0],
  ['as', 0], ['well', 1], ['if', 1], ['you', 1], ['tap', 1], ['into', 1], ['that', 1], ['potential.', 1],
  ['There', 1], ['has', 1], ['to', 1], ['be', 1], ['more.', 1],
];
// generous gaps, so the single-word repair (which needs a tight word followed
// by a pause) has no reason to fire and the boundary is Deepgram's alone
const words = SAID.map(([word, speaker], i) => ({
  word: word.toLowerCase().replace(/[.,]/g, ''),
  punctuated_word: word,
  start: Number((i * 0.5).toFixed(2)),
  end: Number((i * 0.5 + 0.4).toFixed(2)),
  speaker,
}));

const body = (extra) => JSON.stringify({
  results: Object.assign({
    channels: [{ detected_language: 'en', alternatives: [{ transcript: SAID.map((s) => s[0]).join(' '), words }] }],
  }, extra),
});

const paragraphs = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#hypertranscript p')].map((p) =>
    [...p.querySelectorAll('span[data-m]')].map((s) => s.textContent.trim()).join(' ')));

const transcribe = async (page, extra) => {
  await page.route('https://api.deepgram.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: body(extra) }));
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(() => {
    document.getElementById('transcribe-modal').checked = true;
    document.querySelector('#token').value = 'test-token';
    const media = document.querySelector('#deepgram-media');
    media.value = 'https://example.com/debate.mp4';
    media.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#transcribe-btn').click();
  });
  await expect.poll(() => paragraphs(page).then((p) => p.length)).toBe(2);
};

// the boundary Deepgram reports is mid-sentence, and that is what is drawn
const AS_REPORTED = [
  '[speaker-0] We could be there at the start of this new industrial revolution as',
  '[speaker-1] well if you tap into that potential. There has to be more.',
];

test('the speaker boundary is drawn where Deepgram put it', async ({ page }) => {
  await transcribe(page, {});
  expect(await paragraphs(page)).toEqual(AS_REPORTED);
});

test('utterances in the response change nothing', async ({ page }) => {
  // whatever segments arrive, and whatever speakers they carry, the boundary
  // stays where the per-word flags put it
  await transcribe(page, {
    utterances: [
      { speaker: 7, start: 0, end: words[19].end, transcript: 'first' },
      { speaker: 7, start: words[20].start, end: words[24].end, transcript: 'second' },
    ],
  });
  expect(await paragraphs(page)).toEqual(AS_REPORTED);
});

test('the report describes their flags without altering them', async ({ page }) => {
  await transcribe(page, {});
  const report = await page.evaluate(() => window.hyperaudioSpeakerDebug());
  expect(report.changes).toBe(1);
  expect(report.changesMidSentence).toBe(1);   // which is the finding, not a fault of ours
  expect(report.speakers).toEqual([0, 1]);
});

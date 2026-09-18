// The Deepgram parser took the visible text from a SECOND list — the formatted
// transcript split on spaces — matched to the word array by position alone.
// smart_format, which we ask for, is what breaks that: it rewrites spoken
// numbers into forms with a different token count, and from the first mismatch
// every word after it comes from the wrong slot, so speaker labels land against
// the wrong text. The text now comes off each word, beside its own timing and
// speaker, the way the AssemblyAI parser has always done it.
import { test, expect } from '@playwright/test';

// "I said twenty twenty four" spoken by speaker 0, then "It was" by speaker 1.
// smart_format renders the year as one token, so the formatted transcript has
// two fewer tokens than the word array — the shift that displaced the labels.
const WORDS = [
  { word: 'i', punctuated_word: 'I', start: 0.0, end: 0.2, speaker: 0 },
  { word: 'said', punctuated_word: 'said', start: 0.2, end: 0.5, speaker: 0 },
  { word: 'twenty', punctuated_word: '2024.', start: 0.5, end: 0.8, speaker: 0 },
  { word: 'twenty', punctuated_word: '', start: 0.8, end: 1.0, speaker: 0 },
  { word: 'four', punctuated_word: '', start: 1.0, end: 1.3, speaker: 0 },
  { word: 'it', punctuated_word: 'It', start: 1.6, end: 1.8, speaker: 1 },
  { word: 'was', punctuated_word: 'was.', start: 1.8, end: 2.1, speaker: 1 },
];

const RESPONSE = {
  results: {
    channels: [{
      detected_language: 'en',
      alternatives: [{ transcript: 'I said 2024. It was.', words: WORDS }],
    }],
  },
};

test('each word carries its own text, so a speaker label lands on the right word', async ({ page }) => {
  await page.route('https://api.deepgram.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESPONSE) }));

  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.evaluate(() => {
    document.getElementById('transcribe-modal').checked = true;
    document.querySelector('#token').value = 'test-token';
    const media = document.querySelector('#deepgram-media');
    media.value = 'https://example.com/talk.mp4';
    media.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#transcribe-btn').click();
  });

  await expect.poll(() => page.evaluate(() =>
    document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)').length)).toBe(WORDS.length);

  const built = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#hypertranscript span[data-m]').forEach((span) => {
      out.push({ text: span.textContent.trim(), ms: Number(span.getAttribute('data-m')), speaker: span.classList.contains('speaker') });
    });
    return out;
  });

  // no word is undefined or another word's text: each span's text is the one
  // its own timing belongs to
  const words = built.filter((b) => !b.speaker);
  expect(words.map((w) => w.text)).toEqual(['I', 'said', '2024.', 'twenty', 'four', 'It', 'was.']);
  expect(words.map((w) => w.ms)).toEqual(WORDS.map((w) => Math.round(Number(w.start.toFixed(2)) * 1000)));

  // and the label sits at the speaker change, on "It" — the word Deepgram
  // actually changed speaker on, not two words earlier
  const labels = built.filter((b) => b.speaker);
  expect(labels.map((l) => l.text)).toEqual(['[speaker-0]', '[speaker-1]']);
  expect(labels[1].ms).toBe(1600);
  const at = built.findIndex((b) => b.speaker && b.text === '[speaker-1]');
  expect(built[at + 1].text).toBe('It');

  // each label opens its own paragraph, so a label is never mid-sentence in
  // our markup: where one looks mid-sentence, the speaker changed there
  const opens = await page.evaluate(() =>
    [...document.querySelectorAll('#hypertranscript p')].map((p) => {
      const first = p.querySelector('span[data-m]');
      return first !== null && first.classList.contains('speaker');
    }));
  expect(opens.every((o) => o === true)).toBe(true);
});

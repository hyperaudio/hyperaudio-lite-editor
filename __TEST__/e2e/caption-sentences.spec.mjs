// #661, #662 — what ends a caption. Generation used to close a caption at
// every word ending in a full stop: "Dr." cut a sentence in two, and a run of
// short sentences came out one word to a caption. caption.js (vendored from
// hyperaudio-lite) now takes the rules as options, and the editor supplies
// them: abbreviations by the project's language, whole short sentences joined,
// and a Setting for whether a new paragraph always starts a new caption.
import { test, expect } from '@playwright/test';

// One word per 400ms; "|" starts a new paragraph, "@Name" a speaker label.
const transcriptHtml = (text) => {
  let t = 0;
  return '<article><section>' + text.split('|').map((para) =>
    '<p>' + para.trim().split(/\s+/).map((w) => {
      if (w.startsWith('@')) return `<span class="speaker" data-m="${t}" data-d="0">[${w.slice(1)}] </span>`;
      const span = `<span data-m="${t}" data-d="350">${w} </span>`;
      t += 400;
      return span;
    }).join('') + '</p>').join('') + '</section></article>';
};

// The generated cues, each as its text; `sep` shows where its lines break.
const generate = (page, text, sep = ' ') => page.evaluate(async ([html, sep]) => {
  document.getElementById('hypertranscript').innerHTML = html;
  document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
  await new Promise((r) => setTimeout(r, 400));
  return window.MediaExportCaptions.parseVttCues(window.HyperaudioSave.getCaptionsVtt()).map((c) => c.lines.join(sep));
}, [transcriptHtml(text), sep]);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForFunction(() => typeof window.MediaExportCaptions === 'object');
});

test('the rules the generator runs under come from one place (#661, #662)', async ({ page }) => {
  const options = await page.evaluate(() => ({
    unknown: window.captionOptions(''),
    english: window.captionOptions('en-GB'),
    german: window.captionOptions('de'),
    unlisted: window.captionOptions('xx'),
  }));
  expect(options.unknown).toMatchObject({ detectAbbreviations: true, joinSentences: true, paragraphBreaks: false, abbreviations: [] });
  expect(options.english.abbreviations).toContain('Dr.');
  expect(options.german.abbreviations).toContain('Hr.');
  expect(options.english.abbreviations).not.toContain('Hr.');
  expect(options.unlisted.abbreviations).toEqual([]);
});

test('dotted abbreviations need no language at all (#662)', async ({ page }) => {
  expect(await generate(page, 'It costs 3.5 million, e.g. for a small firm.'))
    .toEqual(['It costs 3.5 million, e.g. for a small firm.']);
  expect(await generate(page, 'We left at 5 p.m. Then the rain came down on all of us.'))
    .toEqual(['We left at 5 p.m.', 'Then the rain came down on all of us.']);
});

test('a title is an abbreviation only in a language that lists it (#662)', async ({ page }) => {
  // language unknown: no list, so "Dr." still reads as a sentence end
  expect(await generate(page, 'We spoke to Dr. Smith about the whole of it today.'))
    .toEqual(['We spoke to Dr.', 'Smith about the whole of it today.']);

  // the project's language is what an engine reports with its transcript
  await page.evaluate(() => {
    window.__lang = (code) => { window.HyperaudioSave.getProjectLanguage = () => code; };
    window.__lang('en');
  });
  expect(await generate(page, 'We spoke to Dr. Smith about the whole of it today.'))
    .toEqual(['We spoke to Dr. Smith about the whole of it today.']);
  // English lists no "Hr.": it ends a sentence, and the line breaks after it.
  // (The two short "sentences" still share a caption — that is #661 — so it is
  // the line break that shows where the generator saw a sentence end.)
  expect(await generate(page, 'Wir trafen Hr. Schmidt gestern in der Stadt.', ' / '))
    .toEqual(['Wir trafen Hr. / Schmidt gestern in der Stadt.']);
  await page.evaluate(() => window.__lang('de-AT'));
  const german = await generate(page, 'Wir trafen Hr. Schmidt gestern in der Stadt.', ' / ');
  expect(german).toHaveLength(1);
  expect(german[0]).toContain('Hr. Schmidt');   // one sentence, wrapped by length alone
});

test('short sentences share a caption; a long one is never split to fill one (#661)', async ({ page }) => {
  expect(await generate(page, 'Yes. No. Maybe. I see. Go on. Fine. That is all. Thanks.'))
    .toEqual(['Yes. No. Maybe. I see. Go on. Fine. That is all. Thanks.']);
  const cues = await generate(page, 'Yes. This sentence is far too long to sit on one line of a caption.');
  expect(cues[0]).toBe('Yes.');
  expect(cues.slice(1).join(' ')).toBe('This sentence is far too long to sit on one line of a caption.');
});

test('a speaker label always starts a new caption (#661)', async ({ page }) => {
  expect(await generate(page, '@Ann Yes. No. | @Bob Maybe. Fine.')).toEqual(['Yes. No.', 'Maybe. Fine.']);
  // so every cue still belongs to one speaker, which is what #536 records
  expect(await page.evaluate(() => window.captionSpeakerList())).toEqual(['Ann', 'Bob']);
});

test('the paragraph setting decides whether a caption may span a paragraph break (#661)', async ({ page }) => {
  expect(await page.evaluate(() => window.HyperaudioSettings.get('captionParagraphBreaks'))).toBe(false);
  expect(await generate(page, 'Yes. No. | Maybe. Fine.')).toEqual(['Yes. No. Maybe. Fine.']);

  // through the Settings control, as a user would
  await page.evaluate(() => {
    const t = document.getElementById('settings-modal'); t.checked = true; t.dispatchEvent(new Event('change'));
    document.getElementById('settings-tab-captions').click();
  });
  await page.check('#setting-caption-paragraph-breaks', { force: true });
  expect(await page.evaluate(() => window.HyperaudioSettings.get('captionParagraphBreaks'))).toBe(true);
  expect(await generate(page, 'Yes. No. | Maybe. Fine.')).toEqual(['Yes. No.', 'Maybe. Fine.']);
  // a paragraph that ends without punctuation breaks there too
  expect(await generate(page, 'the first thought | the second thought')).toEqual(['the first thought', 'the second thought']);

  // and it survives a reload, like the other caption settings
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForFunction(() => typeof window.MediaExportCaptions === 'object');
  expect(await page.isChecked('#setting-caption-paragraph-breaks')).toBe(true);
  expect(await generate(page, 'Yes. No. | Maybe. Fine.')).toEqual(['Yes. No.', 'Maybe. Fine.']);
});

test('the export fallback generates under the same rules (#661)', async ({ page }) => {
  // no caption track at all: the export's own generator is what runs
  const subs = await page.evaluate((html) => {
    document.getElementById('hypertranscript').innerHTML = html;
    document.getElementById('hyperplayer-vtt').src = '';
    return window.MediaExportCaptions.genRetimedCaptions([{ start: 0, end: 600 }], 1, false);
  }, transcriptHtml('Yes. No. Maybe. Fine.'));
  const cues = subs.vtt.split('\n\n').slice(1).filter((b) => b.trim() !== '');
  expect(cues).toHaveLength(1);
  expect(subs.vtt).toContain('Yes. No. Maybe. Fine.');
});

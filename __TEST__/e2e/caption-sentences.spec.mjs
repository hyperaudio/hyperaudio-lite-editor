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
  expect(options.unknown).toMatchObject({ detectAbbreviations: true, joinSentences: true, paragraphBreaks: false });
  // no language recorded: the transcript on screen is read instead — the
  // intro, which is English
  expect(options.unknown.abbreviations).toEqual(options.english.abbreviations);
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

// The language reaches the generator the way it does in use: the engine
// reports it with its transcript. The first version of this test stubbed the
// language with a code, and so never met what engines really report — the
// picker's LABEL, "English" — under which no list was ever found.
const report = (page, info) => page.evaluate((info) =>
  window.setTranscriptionInfo(Object.assign({ service: 'Test engine', model: 'm' }, info)), info);

test('a title is an abbreviation only in a language that lists it (#662)', async ({ page }) => {
  const DR = 'We spoke to Dr. Smith about the whole of it today.';
  const HR = 'Wir trafen Hr. Schmidt gestern in der Stadt.';

  // no language recorded, and too few words to read one from: the titles
  // that belong to no language still hold, a German one does not
  expect(await generate(page, DR)).toEqual([DR]);
  expect(await generate(page, HR, ' / ')).toEqual(['Wir trafen Hr. / Schmidt gestern in der Stadt.']);

  // the picker's label alone, which is all some engines give
  await report(page, { language: 'English' });
  expect(await page.evaluate(() => window.HyperaudioSave.getProjectLanguage())).toBe('en');
  expect(await generate(page, DR)).toEqual([DR]);
  // English lists no "Hr.": it ends a sentence, and the line breaks after it.
  // (The two short "sentences" still share a caption — that is #661 — so it is
  // the line break that shows where the generator saw a sentence end.)
  expect(await generate(page, HR, ' / ')).toEqual(['Wir trafen Hr. / Schmidt gestern in der Stadt.']);

  // auto-detect: the label says nothing, the engine's own code does
  await report(page, { language: 'Automatic language detection', languageCode: 'de' });
  const german = await generate(page, HR, ' / ');
  expect(german).toHaveLength(1);
  expect(german[0]).toContain('Hr. Schmidt');   // one sentence, wrapped by length alone

  // AssemblyAI's spelling of a regional code
  await report(page, { language: 'Global English', languageCode: 'en_us' });
  expect(await page.evaluate(() => window.HyperaudioSave.getProjectLanguage())).toBe('en-US');
  expect(await generate(page, DR)).toEqual([DR]);
});

test('a project whose engine recorded no language is read from its transcript (#662)', async ({ page }) => {
  // what AssemblyAI's language detection and Parakeet (local) leave behind
  await report(page, { language: 'Auto-detect' });
  expect(await page.evaluate(() => window.HyperaudioSave.getProjectLanguage())).toBe('');

  const english = 'Sure. So to start off, Gen. Ashby, can you just introduce yourself and give us a little insight into your background and where you are from?';
  const cues = await generate(page, english, ' / ');
  // "Gen." is on the English list and not among the titles of no language
  expect(cues.some((c) => /Gen\.$/.test(c) || c.includes('Gen. /'))).toBe(false);
  expect(cues.join(' ')).toContain('Gen. Ashby');

  const german = 'Ich denke, dass wir heute mit Hr. Schmidt über die Frage sprechen, wie sich die Stadt in den letzten Jahren verändert hat und was das für uns bedeutet.';
  const deCues = await generate(page, german, ' / ');
  expect(deCues.some((c) => /Hr\.$/.test(c) || c.includes('Hr. /'))).toBe(false);
  expect(await page.evaluate(() => window.captionOptions().abbreviations)).toContain('Hr.');

  // and the guess is never written down as the project's language
  expect(await page.evaluate(() => window.HyperaudioSave.getProjectLanguage())).toBe('');
});

test('a recorded language is never second-guessed (#662)', async ({ page }) => {
  // the engine said German; an English passage in it does not change that
  await report(page, { language: 'German', languageCode: 'de' });
  await generate(page, 'Sure. So to start off, can you just introduce yourself and give us a little insight into your background and where you are from today?');
  const list = await page.evaluate(() => window.captionOptions().abbreviations);
  expect(list).toContain('Hr.');
  expect(list).not.toContain('Gen.');
});

test('the language is saved as a tag, and an older project saved with a label still works (#662)', async ({ page }) => {
  const DR = 'We spoke to Dr. Smith about the whole of it today.';
  await generate(page, DR);
  await report(page, { language: 'English' });
  const saved = await page.evaluate(async () => {
    const save = window.HyperaudioSave;
    await save.saveProject();
    const dir = await save.storage.projectDir(save.library.currentId());
    const state = JSON.parse(await save.storage.readText(dir, 'saved.json'));
    const container = JSON.parse(state.json);
    const was = container.texts.language;
    // an older build wrote the picker's label here
    container.texts.language = 'English';
    state.json = JSON.stringify(container);
    await save.storage.writeFile(dir, 'saved.json', JSON.stringify(state));
    return was;
  });
  expect(saved).toBe('en');                     // BCP-47, as the format says

  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await page.waitForFunction(() => typeof window.MediaExportCaptions === 'object');
  expect(await page.evaluate(() => window.HyperaudioSave.getProjectLanguage())).toBe('en');
  expect(await generate(page, DR)).toEqual([DR]);
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

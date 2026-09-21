// texts.language is a BCP-47 tag, and the engines were handing over whatever
// their language picker showed. One reader turns either into a tag (#662).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { languageTag } = createRequire(import.meta.url)('../../js/hyperaudio-save.js');

test('codes, in any engine\'s spelling, become tags', () => {
  assert.equal(languageTag('en'), 'en');
  assert.equal(languageTag('EN'), 'en');
  assert.equal(languageTag('en_us'), 'en-US');
  assert.equal(languageTag('en-gb'), 'en-GB');
  assert.equal(languageTag('pt-BR'), 'pt-BR');
  assert.equal(languageTag('zh-Hans'), 'zh-Hans');
});

test('a picker\'s label is read as a language name', () => {
  assert.equal(languageTag('English'), 'en');
  assert.equal(languageTag('Global English'), 'en');
  assert.equal(languageTag('English (Australia)'), 'en');
  assert.equal(languageTag('German'), 'de');
  assert.equal(languageTag('Deutsch'), 'de');
  assert.equal(languageTag('Español'), 'es');
  assert.equal(languageTag('Portuguese (Brazil)'), 'pt');
});

test('what is not a language is unknown', () => {
  ['', null, undefined, 'xx', 'auto', 'multi', 'Auto-detect', 'Automatic language detection',
    'Multilingual (code-switching)', 'language unknown', 'Klingon'].forEach((v) => {
    assert.equal(languageTag(v), '', String(v));
  });
});

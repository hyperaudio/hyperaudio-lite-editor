const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const converterCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'gentle-json-converter.js'), 'utf8');
const context = {
  module: { exports: {} },
  globalThis: {}
};
context.globalThis = context;
vm.runInNewContext(converterCode, context);

const {
  gentleJsonToHyperaudioJson,
  hyperaudioJsonToGentleJson
} = context.module.exports;

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

const gentleP = {
  transcript: '[+] This audio recording. \\||\n\n[+] TIME-CODES work.',
  words: [
    { alignedWord: 'this', case: 'success', end: 0.31, endOffset: 8, phones: [], start: 0.04, startOffset: 4, word: 'This' },
    { alignedWord: 'audio', case: 'success', end: 0.69, endOffset: 14, phones: [], start: 0.33, startOffset: 9, word: 'audio' },
    { alignedWord: 'recording', case: 'success', end: 1.2, endOffset: 24, phones: [], start: 0.69, startOffset: 15, word: 'recording' },
    { case: 'not-found-in-audio', endOffset: 29, startOffset: 27, word: 'um' },
    { alignedWord: 'time', case: 'success', end: 2.4, endOffset: 39, phones: [], start: 2.0, startOffset: 35, word: 'TIME' },
    { alignedWord: 'codes', case: 'success', end: 3.0, endOffset: 45, phones: [], start: 2.4, startOffset: 40, word: 'CODES' },
    { alignedWord: 'work', case: 'success', end: 3.5, endOffset: 50, phones: [], start: 3.1, startOffset: 46, word: 'work' }
  ]
};
const hyperaudioP = gentleJsonToHyperaudioJson(gentleP);

assert.equal(hyperaudioP.words.length, 6);
assert.equal(hyperaudioP.words[0].text, 'This');
assert.equal(hyperaudioP.words[0].start, 0.04);
assert.equal(hyperaudioP.words[0].end, 0.31);
assert.equal(hyperaudioP.words[2].text, 'recording.');
assert.equal(hyperaudioP.words.at(-1).text, 'work.');
assert.ok(hyperaudioP.paragraphs.length > 1, 'Gentle paragraph markers create paragraph boundaries');
assert.equal(hyperaudioP.sections.length, 1);
assert.equal(hyperaudioP.sections[0].start, 0.04);
assert.equal(hyperaudioP.sections[0].end, 3.5);

assert.equal(hyperaudioP.words[3].text, 'TIME-');
assert.equal(hyperaudioP.words[4].text, 'CODES');
assert.ok(hyperaudioP.words.find((word) => word.text === 'work.'), 'preserves punctuation that appears between Gentle word offsets');

for (const fixture of ['gentle-sample-p.json', 'gentle-sample-h.json']) {
  const source = loadFixture(fixture);
  const converted = gentleJsonToHyperaudioJson(source);
  const successfulWords = source.words.filter((word) => word.case === 'success');

  assert.equal(converted.words.length, successfulWords.length, `${fixture} imports all successful Gentle words`);
  assert.equal(converted.words[0].text, 'This');
  assert.equal(converted.words.at(-1).text, 'format.');
  assert.equal(converted.paragraphs.length, 13, `${fixture} preserves sentence and paragraph marker boundaries`);
  assert.equal(JSON.stringify(converted.sections), JSON.stringify([{ start: converted.words[0].start, end: converted.words.at(-1).end }]));

  const exported = hyperaudioJsonToGentleJson(converted);
  assert.equal(exported.words.length, converted.words.length, `${fixture} can round-trip exported word offsets`);
  assert.equal(exported.words[0].startOffset, 0);
  assert.equal(exported.words.at(-1).word, 'format');
}

const homophoneSample = gentleJsonToHyperaudioJson(loadFixture('gentle-sample-h.json'));
assert.ok(homophoneSample.words.find((word) => word.text === 'TIME-CODE'), 'preserves homophone hyphenation from issue sample');
assert.ok(homophoneSample.words.find((word) => word.text === 'YOU-'), 'preserves hyphenated homophone word prefixes');

const exportedGentle = hyperaudioJsonToGentleJson({
  words: [
    { start: 0, end: 0.2, text: 'TIME-' },
    { start: 0.2, end: 0.5, text: 'CODES.' },
    { start: 0.8, end: 1.1, text: 'Next' }
  ]
});

assert.equal(exportedGentle.transcript, 'TIME-CODES. Next');
const exportedOffsets = exportedGentle.words.map((word) => ({
  word: word.word,
  startOffset: word.startOffset,
  endOffset: word.endOffset
}));

assert.equal(JSON.stringify(exportedOffsets), JSON.stringify([
  { word: 'TIME', startOffset: 0, endOffset: 4 },
  { word: 'CODES', startOffset: 5, endOffset: 10 },
  { word: 'Next', startOffset: 12, endOffset: 16 }
]));

console.log('gentle-json-converter tests passed');

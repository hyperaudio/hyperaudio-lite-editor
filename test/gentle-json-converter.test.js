const assert = require('assert');

const {
  gentleToHyperaudioJson,
  hyperaudioJsonToGentle
} = require('../js/gentle-json-converter');

const gentleImport = gentleToHyperaudioJson({
  mediaUrl: 'https://example.com/audio.mp3',
  words: [
    { word: '[+]Hello', start: 0.1, end: 0.3 },
    { word: 'world\\\\', start: 0.4, end: 0.7 },
    { word: 'next||', start: 1.2, end: 1.5 },
    { word: '[+]Again', start: 2.1, end: 2.4 },
    { word: 'done||', start: 2.6, end: 2.9 },
    { case: 'not-found-in-audio', word: 'ignored' }
  ]
});

assert.deepStrictEqual(
  gentleImport.words.map(word => word.text),
  ['Hello', 'world', 'next', 'Again', 'done']
);
assert.deepStrictEqual(gentleImport.paragraphs, [
  { start: 0.1, end: 1.5 },
  { start: 2.1, end: 2.9 }
]);
assert.deepStrictEqual(gentleImport.sections, [{
  start: 0.1,
  end: 2.9,
  mediaUrl: 'https://example.com/audio.mp3'
}]);

const gentleExport = hyperaudioJsonToGentle({
  words: [
    { start: 0.1, end: 0.3, text: 'Hello' },
    { start: 0.4, end: 0.7, text: 'world' }
  ]
});

assert.strictEqual(gentleExport.transcript, 'Hello world');
assert.deepStrictEqual(gentleExport.words, [
  {
    alignedWord: 'hello',
    case: 'success',
    end: 0.3,
    endOffset: 5,
    phones: [],
    start: 0.1,
    startOffset: 0,
    word: 'Hello'
  },
  {
    alignedWord: 'world',
    case: 'success',
    end: 0.7,
    endOffset: 11,
    phones: [],
    start: 0.4,
    startOffset: 6,
    word: 'world'
  }
]);

console.log('gentle-json-converter tests passed');

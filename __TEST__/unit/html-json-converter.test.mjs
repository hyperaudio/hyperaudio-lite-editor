// Unit tests for jsonToHTML's escaping (#406): word text and speaker names from
// (possibly third-party) transcript JSON must not become live markup — raw
// interpolation meant "<inaudible>" vanished as a bogus tag and a hostile
// payload executed when the HTML landed in innerHTML. htmlToJSON needs a DOM
// (DOMParser), so the decode half of the round trip is covered in e2e; the
// serialization half is pure string and lives here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { jsonToHTML } = require('../../js/html-json-converter.js');

test('word text is escaped: <inaudible> and & survive as text, not markup (#406)', () => {
  const html = jsonToHTML({
    words: [
      { start: 1.0, end: 1.5, text: '<inaudible>' },
      { start: 1.6, end: 2.0, text: 'AT&T' },
    ],
  });
  assert.match(html, /&lt;inaudible&gt; /);
  assert.match(html, /AT&amp;T /);
  assert.doesNotMatch(html, /<inaudible>/);
});

test('speaker names are escaped, including quotes (#406)', () => {
  const html = jsonToHTML({
    words: [{ start: 1.0, end: 1.5, text: 'hello' }],
    paragraphs: [{ speaker: 'Q&A "host" <b>', start: 0.5, end: 2.0 }],
  });
  assert.match(html, /\[Q&amp;A &quot;host&quot; &lt;b&gt;\] /);
  assert.doesNotMatch(html, /<b>/);
});

test('an XSS payload in transcript JSON is neutralised (#406)', () => {
  const html = jsonToHTML({
    words: [{ start: 0, end: 1, text: '<img src=x onerror=alert(1)>' }],
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('clean text is untouched', () => {
  const html = jsonToHTML({
    words: [{ start: 4.76, end: 5.28, text: 'Testing' }],
    paragraphs: [{ speaker: 'Alice', start: 4.76, end: 5.28 }],
  });
  assert.match(html, /<span data-m="4760" data-d="0" class="speaker">\[Alice\] <\/span>/);
  assert.match(html, /<span data-m="4760" data-d="520">Testing <\/span>/);
});

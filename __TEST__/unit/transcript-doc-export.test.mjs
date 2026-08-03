// Unit tests for the transcript document exports (#467): the pure TXT and
// Markdown renderers over the words/paragraphs model. Rendered semantics:
// struck (redacted) words dropped, speakers as prefixes, paragraphs as
// blank-line-separated blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const doc = require('../../js/transcript-doc-export.js');

function sampleTranscript() {
  return {
    words: [
      { start: 0.32, end: 0.84, text: 'Benvenuti' },
      { start: 0.84, end: 1.02, text: 'ehm', struck: true },
      { start: 1.1, end: 1.3, text: 'a' },
      { start: 1.4, end: 1.9, text: 'Hyperaudio' },
      { start: 6.6, end: 7.0, text: 'Grazie' },
      { start: 7.1, end: 7.4, text: 'mille', struck: true },
    ],
    paragraphs: [
      { speaker: 'Maria', start: 0.32, end: 6.5 },
      { speaker: 'Luca', start: 6.6, end: 8.0 },
    ],
  };
}

/* ---------- TXT ---------- */

test('txt: speaker prefixes, paragraphs blank-line separated, struck words dropped', () => {
  assert.equal(doc.renderTxt(sampleTranscript()),
    'Maria: Benvenuti a Hyperaudio\n\nLuca: Grazie\n');
});

test('txt: no paragraphs → one unprefixed block', () => {
  const out = doc.renderTxt({ words: [
    { start: 0, end: 1, text: 'just' },
    { start: 1, end: 2, text: 'words' },
  ], paragraphs: [] });
  assert.equal(out, 'just words\n');
});

test('txt: space:false joins without a gap (dropping struck neighbours stays clean)', () => {
  const out = doc.renderTxt({ words: [
    { start: 0, end: 1, text: 'draft' },
    { start: 1, end: 2, text: 'y', space: false },
    { start: 2, end: 3, text: 'REDACTED', struck: true },
    { start: 3, end: 4, text: '-note' },
  ], paragraphs: [] });
  assert.equal(out, 'draft y-note\n');
});

test('txt: empty and all-struck transcripts render to an empty string', () => {
  assert.equal(doc.renderTxt({ words: [], paragraphs: [] }), '');
  assert.equal(doc.renderTxt({ words: [{ start: 0, end: 1, text: 'x', struck: true }], paragraphs: [] }), '');
});

test('txt: a paragraph whose every word is struck disappears entirely', () => {
  const out = doc.renderTxt({
    words: [
      { start: 0, end: 1, text: 'kept' },
      { start: 5, end: 6, text: 'gone', struck: true },
    ],
    paragraphs: [
      { speaker: 'A', start: 0, end: 4 },
      { speaker: 'B', start: 5, end: 8 },
    ],
  });
  assert.equal(out, 'A: kept\n'); // no dangling "B:" prefix
});

/* ---------- Markdown ---------- */

test('md: bold speaker prefixes, same structure and redaction semantics', () => {
  assert.equal(doc.renderMarkdown(sampleTranscript()),
    '**Maria:** Benvenuti a Hyperaudio\n\n**Luca:** Grazie\n');
});

test('md: inline-construct characters in words and speaker names are escaped', () => {
  const out = doc.renderMarkdown({
    words: [{ start: 0, end: 1, text: '*laughs*' }, { start: 1, end: 2, text: '[sighs]' }],
    paragraphs: [{ speaker: 'M_C*', start: 0, end: 4 }],
  });
  assert.equal(out, '**M\\_C\\*:** \\*laughs\\* \\[sighs\\]\n');
});

test('md: empty transcript renders to an empty string', () => {
  assert.equal(doc.renderMarkdown({ words: [], paragraphs: [] }), '');
});

/* ---------- DOCX ---------- */

const JSZip = require('jszip');

test('docx: package round-trips with bold speaker runs, struck words dropped', async () => {
  const out = await doc.buildDocx(sampleTranscript(), JSZip, 'nodebuffer');
  const zip = await JSZip.loadAsync(out);
  const types = await zip.file('[Content_Types].xml').async('string');
  assert.match(types, /wordprocessingml\.document\.main\+xml/);
  const rels = await zip.file('_rels/.rels').async('string');
  assert.match(rels, /Target="word\/document\.xml"/);
  const docXml = await zip.file('word/document.xml').async('string');
  assert.match(docXml, /<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Maria: <\/w:t><\/w:r>/);
  assert.match(docXml, /<w:t xml:space="preserve">Benvenuti a Hyperaudio<\/w:t>/);
  assert.ok(!docXml.includes('ehm')); // redacted: must not survive
  assert.match(docXml, /Luca: /);
});

test('docx: word text is XML-escaped', () => {
  const xml = doc.docxDocumentXml({
    words: [{ start: 0, end: 1, text: 'a<b>&"c"' }],
    paragraphs: [{ speaker: 'R&D', start: 0, end: 2 }],
  });
  assert.ok(xml.includes('a&lt;b&gt;&amp;"c"')); // & < > escaped; quotes fine in text nodes
  assert.ok(xml.includes('R&amp;D: '));
  assert.ok(!xml.includes('<b>'));
});

test('docx: empty transcript still yields a valid document with one empty paragraph', () => {
  const xml = doc.docxDocumentXml({ words: [], paragraphs: [] });
  assert.match(xml, /<w:body><w:p\/><\/w:body>/);
});

/* ---------- Clipboard HTML ---------- */

test('clipboard html: conservative <p>/<b> markup, redaction and escaping shared', () => {
  const out = doc.renderClipboardHtml(sampleTranscript());
  assert.equal(out,
    '<p><b>Maria:</b> Benvenuti a Hyperaudio</p>\n<p><b>Luca:</b> Grazie</p>');
});

test('clipboard html: word text is HTML-escaped, no injected markup', () => {
  const out = doc.renderClipboardHtml({
    words: [{ start: 0, end: 1, text: '<img src=x>' }],
    paragraphs: [{ speaker: 'A&B', start: 0, end: 2 }],
  });
  assert.equal(out, '<p><b>A&amp;B:</b> &lt;img src=x&gt;</p>');
});

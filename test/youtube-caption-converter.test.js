const assert = require('assert');

const {
  hyperaudioJsonToYoutubeTimedTextXml,
  hyperaudioJsonToYoutubeVtt,
  youtubeTimedTextXmlToHtml,
  youtubeVttToHtml,
} = require('../js/youtube-caption-converter.js');

function spanTuples(html) {
  return Array.from(html.matchAll(/<span data-m="(\d+)" data-d="(\d+)">([^<]*)<\/span>/g))
    .map((match) => ({
      startMs: Number(match[1]),
      durationMs: Number(match[2]),
      text: match[3].trim(),
    }));
}

{
  const html = youtubeVttToHtml(`WEBVTT

00:00:00.000 --> 00:00:03.000 align:start position:0%
<00:00:00.500>Hello <00:00:01.250>world.
`);

  assert.deepStrictEqual(spanTuples(html), [
    { startMs: 500, durationMs: 750, text: 'Hello' },
    { startMs: 1250, durationMs: 1750, text: 'world.' },
  ]);
}

{
  const html = youtubeTimedTextXmlToHtml(`
<timedtext>
  <body>
    <p t="1000" d="2500">
      <s t="0" d="400">Hello</s>
      <s t="600" d="500">world</s>
    </p>
  </body>
</timedtext>
`);

  assert.deepStrictEqual(spanTuples(html), [
    { startMs: 1000, durationMs: 400, text: 'Hello' },
    { startMs: 1600, durationMs: 500, text: 'world' },
  ]);
}

{
  const html = youtubeTimedTextXmlToHtml(`
<transcript>
  <text start="0.5" dur="1.5">Hello &amp; world</text>
</transcript>
`);

  assert.deepStrictEqual(spanTuples(html), [
    { startMs: 500, durationMs: 500, text: 'Hello' },
    { startMs: 1000, durationMs: 500, text: '&amp;' },
    { startMs: 1500, durationMs: 500, text: 'world' },
  ]);
}

{
  const json = {
    words: [
      { start: 0.5, end: 1.25, text: 'Hello' },
      { start: 1.25, end: 3, text: 'world.' },
    ],
    paragraphs: [{ start: 0.5, end: 3 }],
  };

  const vtt = hyperaudioJsonToYoutubeVtt(json);
  assert.match(vtt, /WEBVTT/);
  assert.match(vtt, /00:00:00\.500 --> 00:00:03\.000/);
  assert.match(vtt, /<00:00:00\.500>Hello <00:00:01\.250>world\./);

  const xml = hyperaudioJsonToYoutubeTimedTextXml(json);
  assert.match(xml, /<timedtext>/);
  assert.match(xml, /<p t="500" d="2500">/);
  assert.match(xml, /<s t="0" d="750">Hello<\/s><s t="750" d="1750">world\.<\/s>/);
}

/*! (C) The Hyperaudio Project. AGPL 3.0 @license: https://www.gnu.org/licenses/agpl-3.0.en.html */
/*! Hyperaudio Lite Editor - ionosphere (AT Protocol) transcript export. @version 0.6.18 */

// Self-contained, modular export feature. To remove it entirely: delete this
// file, its <script> tag in index.html, and the <export-ionosphere> menu item.
//
// Serializes the canonical transcript JSON ({ words, paragraphs }, as produced
// by htmlToJSON in html-json-converter.js) into the tv.ionosphere / pub.layers
// record set that ATmosphereConf's transcript pipeline reads. This is the
// inverse of transcript-from-ionosphere.ts in the atproto-conf repo.
//
// v1 emits the record set as a downloadable JSON file (no PDS write). The repo
// `did` is a placeholder and the talk rkey is a freshly generated TID — replace
// the did before publishing the records to a PDS with com.atproto.repo.putRecord.
//
// Note: byte ranges are UTF-8 offsets (TextEncoder), never string indices —
// otherwise any non-ASCII word desyncs every later span.

(function () {
  'use strict';

  const PLACEHOLDER_DID = 'did:plc:REPLACE_ME';
  const MAX_TOKEN_BYTES = 900000; // atproto record values cap ~1 MB; leave headroom

  const utf8 = new TextEncoder();
  const byteLength = (s) => utf8.encode(s).length;

  // atproto's conventional record key: a 13-char base32-sortable TID.
  const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';
  function generateTid() {
    let n =
      ((BigInt(Date.now()) * 1000n) << 10n) |
      BigInt(Math.floor(Math.random() * 1024));
    let s = '';
    for (let i = 0; i < 13; i++) {
      s = TID_ALPHABET[Number(n & 31n)] + s;
      n >>= 5n;
    }
    return s;
  }

  function slugify(name) {
    const slug = String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'speaker';
  }

  // Assign each word to a paragraph index (-1 if outside all). Latest paragraph
  // whose [start, end] contains word.start — matches the render-path bucketing.
  function bucketWords(words, paragraphs) {
    const assign = new Array(words.length).fill(-1);
    let pIdx = 0;
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi];
      while (pIdx < paragraphs.length && w.start > paragraphs[pIdx].end) pIdx++;
      if (pIdx >= paragraphs.length) break;
      while (
        pIdx + 1 < paragraphs.length &&
        paragraphs[pIdx + 1].start <= w.start
      ) {
        pIdx++;
      }
      if (w.start < paragraphs[pIdx].start) continue;
      assign[wi] = pIdx;
    }
    return assign;
  }

  // Greedily pack tokens into shards so each shard's serialised tokens array
  // stays under maxTokenBytes (a single oversized token still gets its own shard).
  function shardTokens(tokens, maxTokenBytes) {
    const shards = [];
    let current = [];
    let currentBytes = 2; // "[]"
    for (const token of tokens) {
      const tokenBytes = byteLength(JSON.stringify(token)) + 1; // + comma
      if (current.length > 0 && currentBytes + tokenBytes > maxTokenBytes) {
        shards.push(current);
        current = [];
        currentBytes = 2;
      }
      current.push(token);
      currentBytes += tokenBytes;
    }
    if (current.length > 0) shards.push(current);
    return shards.length > 0 ? shards : [[]];
  }

  // { words:[{start,end,text}], paragraphs:[{start,end,speaker?}] } -> record set.
  function transcriptJsonToIonosphere(data, opts) {
    const words = (data && data.words) || [];
    const paragraphs = (data && data.paragraphs) || [];
    const did = opts.did;
    const rkey = opts.rkey;
    const createdAt = opts.createdAt || new Date().toISOString();
    const maxTokenBytes = opts.maxTokenBytes || MAX_TOKEN_BYTES;
    const records = [];

    // 1. Expression text + per-word UTF-8 byte ranges (ranges cover the word only).
    const wordSpans = [];
    let text = '';
    let byteCursor = 0;
    for (let i = 0; i < words.length; i++) {
      // Separate from the previous word with a space, unless that word was
      // flagged space:false (a glued split token like "speech"/"-to"/"-text").
      if (i > 0 && words[i - 1].space !== false) {
        text += ' ';
        byteCursor += 1; // a space is one UTF-8 byte
      }
      const byteStart = byteCursor;
      text += words[i].text;
      byteCursor += byteLength(words[i].text);
      wordSpans.push({ byteStart: byteStart, byteEnd: byteCursor });
    }
    records.push({
      collection: 'pub.layers.expression.expression',
      rkey: rkey + '-expression',
      value: { $type: 'pub.layers.expression.expression', text: text, createdAt: createdAt },
    });

    // 2. Word byte-range tokens (kind "word"), sharded.
    const wordTokens = wordSpans.map((span, i) => ({ tokenIndex: i, textSpan: span }));
    shardTokens(wordTokens, maxTokenBytes).forEach((tokens, n) => {
      records.push({
        collection: 'pub.layers.segmentation.segmentation',
        rkey: rkey + '-segmentation-' + (n + 1),
        value: {
          $type: 'pub.layers.segmentation.segmentation',
          tokenizations: [{ kind: 'word', tokens: tokens }],
          createdAt: createdAt,
        },
      });
    });

    // 3. Word temporal-span tokens (kind "word-temporal"), sharded. ms resolution.
    const temporalTokens = words.map((w, i) => ({
      tokenIndex: i,
      temporalSpan: { start: Math.round(w.start * 1000), ending: Math.round(w.end * 1000) },
    }));
    shardTokens(temporalTokens, maxTokenBytes).forEach((tokens, n) => {
      records.push({
        collection: 'pub.layers.segmentation.segmentation',
        rkey: rkey + '-temporal-' + (n + 1),
        value: {
          $type: 'pub.layers.segmentation.segmentation',
          tokenizations: [{ kind: 'word-temporal', tokens: tokens }],
          createdAt: createdAt,
        },
      });
    });

    // 4. Paragraph annotations: byte range spans each paragraph's member words.
    const assign = bucketWords(words, paragraphs);
    const annotations = [];
    for (let p = 0; p < paragraphs.length; p++) {
      let first = -1;
      let last = -1;
      for (let wi = 0; wi < assign.length; wi++) {
        if (assign[wi] !== p) continue;
        if (first === -1) first = wi;
        last = wi;
      }
      if (first === -1) continue; // empty paragraph
      annotations.push({
        label: 'paragraph',
        anchor: {
          textSpan: {
            byteStart: wordSpans[first].byteStart,
            byteEnd: wordSpans[last].byteEnd,
          },
        },
      });
    }
    records.push({
      collection: 'pub.layers.annotation.annotationLayer',
      rkey: rkey + '-paragraphs',
      value: { $type: 'pub.layers.annotation.annotationLayer', annotations: annotations, createdAt: createdAt },
    });

    // 5. Speaker records — one per distinct speaker, first-appearance order.
    const speakerOrder = [];
    paragraphs.forEach((p) => {
      if (p.speaker && speakerOrder.indexOf(p.speaker) === -1) speakerOrder.push(p.speaker);
    });
    const speakerUris = [];
    speakerOrder.forEach((name) => {
      const meta = (opts.speakers && opts.speakers[name]) || {};
      const speakerRkey = meta.rkey || rkey + '-speaker-' + slugify(name);
      const value = { $type: 'tv.ionosphere.speaker', name: name, createdAt: createdAt };
      if (meta.handle) value.handle = meta.handle;
      records.push({ collection: 'tv.ionosphere.speaker', rkey: speakerRkey, value: value });
      speakerUris.push('at://' + did + '/tv.ionosphere.speaker/' + speakerRkey);
    });

    // 6. The talk record.
    const talkValue = { $type: 'tv.ionosphere.talk', speakerUris: speakerUris, createdAt: createdAt };
    if (opts.title) talkValue.title = opts.title;
    if (opts.startsAt) talkValue.startsAt = opts.startsAt;
    if (opts.endsAt) talkValue.endsAt = opts.endsAt;
    records.push({ collection: 'tv.ionosphere.talk', rkey: rkey, value: talkValue });

    return {
      talkUri: 'at://' + did + '/tv.ionosphere.talk/' + rkey,
      did: did,
      rkey: rkey,
      records: records,
    };
  }

  function downloadJsonFile(obj, filename) {
    const dataStr =
      'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(obj, null, 2));
    const a = document.createElement('a');
    a.setAttribute('href', dataStr);
    a.setAttribute('download', filename);
    document.body.appendChild(a); // required for Firefox
    a.click();
    a.remove();
  }

  class ExportIonosphere extends HTMLElement {
    exportIonosphere() {
      const hypertranscript = document.getElementById('hypertranscript');
      if (hypertranscript === null) {
        alert('Currently you can only export from the transcript view.');
        return;
      }
      if (typeof htmlToJSON !== 'function') {
        alert('Transcript JSON converter is unavailable.');
        return;
      }
      const data = htmlToJSON(hypertranscript.innerHTML);
      if (!data.words || data.words.length === 0) {
        alert('No transcript words to export.');
        return;
      }
      const out = transcriptJsonToIonosphere(data, {
        did: PLACEHOLDER_DID,
        rkey: generateTid(),
        createdAt: new Date().toISOString(),
      });
      downloadJsonFile(out, 'ionosphere-records.json');
    }

    connectedCallback() {
      this.innerHTML = '<a>Export ionosphere (AT Protocol) JSON</a>';
      this.addEventListener('click', this.exportIonosphere);
    }
  }

  customElements.define('export-ionosphere', ExportIonosphere);

  // Expose the pure serializer for reuse/testing without the DOM/menu.
  window.transcriptJsonToIonosphere = transcriptJsonToIonosphere;
})();

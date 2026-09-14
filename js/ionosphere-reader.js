/**
 * ionosphere-reader.js
 * (C) The Hyperaudio Project
 * @version 1.3.16 — last changed in release 1.3.16
 * @license MIT
 *
 * Reads an ionosphere talk (tv.ionosphere / pub.layers records, #346) from
 * any AT Protocol repository — public, no sign-in — and rebuilds the
 * canonical transcript { words, paragraphs } the editor's converter
 * renders. The inverse of the serializer in transcript-to-ionosphere.js.
 *
 * No DOM, no editor assumptions: a viewer page can include this file alone
 * and render a talk with hyperaudio-lite. The editor's import, publish and
 * unpublish flows use the same functions (window.IonosphereReader).
 *
 * Words come from slicing the expression text by UTF-8 byte range and
 * pairing each with the temporal token of the same index; a range that
 * starts where the previous one ends is a glued split word (space:false).
 * Paragraphs come from the annotation layer's ranges. The speaker is the
 * talk's, known only when there is exactly one — the format has no
 * per-paragraph speaker yet — and labelled on the first paragraph alone, the
 * editor's convention: a label marks a change of speaker.
 */

(function () {
  'use strict';

  const utf8 = new TextEncoder();

  async function xrpc(url, init) {
    const res = await fetch(url, init);
    let body = null;
    try { body = await res.json(); } catch (e) { /* not json */ }
    if (!res.ok) {
      const msg = body && (body.message || body.error);
      throw new Error(msg ? String(msg) : res.status + ' ' + res.statusText);
    }
    return body;
  }

  // handle → did (a did passes straight through)
  async function resolveDid(identifier) {
    const id = String(identifier || '').trim().replace(/^@/, '');
    if (id.startsWith('did:')) return id;
    const out = await xrpc('https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=' + encodeURIComponent(id));
    if (!out || !out.did) throw new Error('Could not resolve ' + id);
    return out.did;
  }

  // did → the PDS that hosts its repo, from the DID document
  async function resolvePds(did) {
    const url = did.startsWith('did:web:')
      ? 'https://' + did.slice('did:web:'.length) + '/.well-known/did.json'
      : 'https://plc.directory/' + encodeURIComponent(did);
    const doc = await xrpc(url);
    const svc = (doc && doc.service || []).find((s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer');
    if (!svc || !svc.serviceEndpoint) throw new Error('No PDS listed for ' + did);
    return String(svc.serviceEndpoint).replace(/\/$/, '');
  }

  function parseTalkUri(uri) {
    const m = /^at:\/\/(did:[a-z0-9:.%-]+)\/tv\.ionosphere\.talk\/([a-z2-7]{13})$/i.exec(String(uri || '').trim());
    return m === null ? null : { did: m[1], rkey: m[2] };
  }

  const utf8Decoder = new TextDecoder();

  async function getRecord(pds, did, collection, rkey) {
    const out = await xrpc(pds + '/xrpc/com.atproto.repo.getRecord?repo=' + encodeURIComponent(did)
      + '&collection=' + encodeURIComponent(collection) + '&rkey=' + encodeURIComponent(rkey));
    return out && out.value ? out.value : null;
  }

  async function listRecords(pds, did, collection) {
    const out = [];
    let cursor = null;
    do {
      const url = pds + '/xrpc/com.atproto.repo.listRecords?repo=' + encodeURIComponent(did)
        + '&collection=' + encodeURIComponent(collection) + '&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const page = await xrpc(url);
      (page && page.records || []).forEach((r) => out.push({ rkey: String(r.uri).split('/').pop(), value: r.value }));
      cursor = page && page.cursor ? page.cursor : null;
    } while (cursor !== null);
    return out;
  }

  // A talk's record set, back into the canonical { words, paragraphs }.
  async function fetchTalk(talkUri, onStep) {
    const step = typeof onStep === 'function' ? onStep : () => {};
    const talk = parseTalkUri(talkUri);
    if (talk === null) throw new Error('That is not a talk URI (at://did…/tv.ionosphere.talk/…)');
    step('Finding the repository…');
    const pds = await resolvePds(talk.did);
    step('Reading the talk…');
    const talkValue = await getRecord(pds, talk.did, 'tv.ionosphere.talk', talk.rkey);
    if (talkValue === null) throw new Error('No talk at that URI');
    const expression = await getRecord(pds, talk.did, 'pub.layers.expression.expression', talk.rkey + '-expression');
    if (expression === null || typeof expression.text !== 'string') throw new Error('The talk has no text');
    const bytes = utf8.encode(expression.text);

    const segmentation = (await listRecords(pds, talk.did, 'pub.layers.segmentation.segmentation'))
      .filter((r) => r.rkey.startsWith(talk.rkey + '-'));
    const spans = new Map();     // tokenIndex → { byteStart, byteEnd }
    const times = new Map();     // tokenIndex → { start, ending } ms
    segmentation.forEach((r) => {
      ((r.value && r.value.tokenizations) || []).forEach((t) => {
        (t.tokens || []).forEach((tok) => {
          if (t.kind === 'word' && tok.textSpan) spans.set(tok.tokenIndex, tok.textSpan);
          if (t.kind === 'word-temporal' && tok.temporalSpan) times.set(tok.tokenIndex, tok.temporalSpan);
        });
      });
    });
    const indices = Array.from(spans.keys()).sort((a, b) => a - b);
    if (indices.length === 0) throw new Error('The talk has no word timings');
    const words = indices.map((i, n) => {
      const span = spans.get(i);
      const time = times.get(i) || { start: 0, ending: 0 };
      const word = {
        start: time.start / 1000,
        end: time.ending / 1000,
        text: utf8Decoder.decode(bytes.subarray(span.byteStart, span.byteEnd)),
      };
      const next = n + 1 < indices.length ? spans.get(indices[n + 1]) : null;
      if (next !== null && next.byteStart === span.byteEnd) word.space = false;   // glued to the next
      return word;
    });

    let speaker = null;
    const speakerUris = Array.isArray(talkValue.speakerUris) ? talkValue.speakerUris : [];
    if (speakerUris.length === 1) {
      const m = /^at:\/\/([^/]+)\/tv\.ionosphere\.speaker\/([^/]+)$/.exec(speakerUris[0]);
      if (m !== null) {
        const sp = await getRecord(pds, m[1], 'tv.ionosphere.speaker', m[2]).catch(() => null);
        if (sp && typeof sp.name === 'string') speaker = sp.name;
      }
    }

    const layer = await getRecord(pds, talk.did, 'pub.layers.annotation.annotationLayer', talk.rkey + '-paragraphs').catch(() => null);
    const ranges = ((layer && layer.annotations) || [])
      .filter((a) => a.label === 'paragraph' && a.anchor && a.anchor.textSpan)
      .map((a) => a.anchor.textSpan);
    const paragraphs = [];
    ranges.forEach((r) => {
      const members = words.filter((w, n) => spans.get(indices[n]).byteStart >= r.byteStart && spans.get(indices[n]).byteEnd <= r.byteEnd);
      if (members.length === 0) return;
      paragraphs.push({ start: members[0].start, end: members[members.length - 1].end });
    });
    if (paragraphs.length === 0) paragraphs.push({ start: words[0].start, end: words[words.length - 1].end });
    if (speaker !== null) paragraphs[0].speaker = speaker;
    // The media, one hop away: the expression's mediaRef names a media record
    // (a Hyperaudio io.hyperaud.media one carries a url; any record with a url
    // field is honoured). Absent or unreadable means no media, not a failure.
    let media = null;
    const ref = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(String(expression.mediaRef || ''));
    if (ref !== null) {
      const rec = await getRecord(pds, ref[1], ref[2], ref[3]).catch(() => null);
      if (rec && typeof rec.url === 'string' && /^https?:\/\//.test(rec.url)) {
        media = { url: rec.url, uri: expression.mediaRef };
        if (rec.mimeType) media.mimeType = String(rec.mimeType);
        if (Number.isFinite(rec.durationMs)) media.durationMs = rec.durationMs;
      }
    }
    return { data: { words: words, paragraphs: paragraphs }, title: typeof talkValue.title === 'string' ? talkValue.title : '', speaker: speaker, media: media };
  }

  window.IonosphereReader = Object.freeze({ xrpc, parseTalkUri, resolveDid, resolvePds, getRecord, listRecords, fetchTalk });
})();

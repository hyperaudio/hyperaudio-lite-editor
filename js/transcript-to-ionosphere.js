/*! (C) The Hyperaudio Project. AGPL 3.0 @license: https://www.gnu.org/licenses/agpl-3.0.en.html */
/*! Hyperaudio Lite Editor - ionosphere (AT Protocol) transcript export. @version 1.3.16 — last changed in release 1.3.16 */

// Self-contained, modular export feature. To remove it entirely: delete this
// file and ionosphere-reader.js, their <script> tags in index.html, and the
// <export-ionosphere>, <publish-ionosphere> and <import-ionosphere> menu
// items (both modals are built here).
//
// Serializes the canonical transcript JSON ({ words, paragraphs }, as produced
// by htmlToJSON in html-json-converter.js) into the tv.ionosphere / pub.layers
// record set that ATmosphereConf's transcript pipeline reads. This is the
// inverse of transcript-from-ionosphere.ts in the atproto-conf repo.
//
// Two doors. "Ionosphere (AT Protocol) JSON" downloads the record set with a
// placeholder `did` and a freshly generated TID rkey. "Publish to PDS…" (#346)
// signs in to the user's own PDS with a handle and an app password, resolves
// the real did, and writes the records with com.atproto.repo.applyWrites —
// in chunks of 200, the endpoint's limit, with validation off because a PDS
// does not know these lexicons. The password is held for the call only; the
// handle is remembered. The same modal unpublishes (#623): every record of
// a talk, found in the repo by the talk's rkey, deleted talk first. And FILE →
// Import → "Ionosphere (AT Protocol) talk" reads a talk back into the
// editor from its URI — repositories are public, so no sign-in.
//
// Note: byte ranges are UTF-8 offsets (TextEncoder), never string indices —
// otherwise any non-ASCII word desyncs every later span.

(function () {
  'use strict';

  const PLACEHOLDER_DID = 'did:plc:REPLACE_ME';
  // The media's own record (#346). Both slots the lexicons offer for media
  // — videoUri on the talk, mediaRef on the expression — take an AT URI to
  // a media RECORD, and the editor's media is a file or an https URL with no
  // record anywhere. So the media gets one, in the publisher's repo, under a
  // Hyperaudio lexicon, and the expression's mediaRef points at it: one hop
  // for a consumer, and unpublish finds it by the talk's rkey like the rest.
  // Written only when the media is a URL; a local file has nothing to link.
  const MEDIA_COLLECTION = 'io.hyperaud.media';
  const MAX_TOKEN_BYTES = 900000; // atproto record values cap ~1 MB; leave headroom

  const utf8 = new TextEncoder();
  const byteLength = (s) => utf8.encode(s).length;

  // Reading, resolving and the xrpc call live in ionosphere-reader.js, which
  // a viewer page can include on its own; this module adds the editor's
  // doors — export, publish, unpublish, import.
  const reader = () => window.IonosphereReader;
  const xrpc = (url, init) => reader().xrpc(url, init);
  const parseTalkUri = (uri) => reader().parseTalkUri(uri);
  const resolveDid = (id) => reader().resolveDid(id);
  const resolvePds = (did) => reader().resolvePds(did);
  const listRecords = (pds, did, collection) => reader().listRecords(pds, did, collection);
  const fetchTalk = (uri, onStep) => reader().fetchTalk(uri, onStep);

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

    // 0. The media record, when the media has a URL (see MEDIA_COLLECTION).
    let mediaRef = null;
    if (opts.media && typeof opts.media.url === 'string' && /^https?:\/\//.test(opts.media.url)) {
      const mediaRkey = rkey + '-media';
      const value = { $type: MEDIA_COLLECTION, url: opts.media.url, createdAt: createdAt };
      if (opts.media.mimeType) value.mimeType = String(opts.media.mimeType);
      if (Number.isFinite(opts.media.durationMs) && opts.media.durationMs > 0) value.durationMs = Math.round(opts.media.durationMs);
      if (opts.media.sha256) value.sha256 = String(opts.media.sha256);
      records.push({ collection: MEDIA_COLLECTION, rkey: mediaRkey, value: value });
      mediaRef = 'at://' + did + '/' + MEDIA_COLLECTION + '/' + mediaRkey;
    }

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
    const expression = { $type: 'pub.layers.expression.expression', text: text, createdAt: createdAt };
    if (mediaRef !== null) expression.mediaRef = mediaRef;   // "AT URI of the media record this expression derives from"
    records.push({
      collection: 'pub.layers.expression.expression',
      rkey: rkey + '-expression',
      value: expression,
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

  /* ---- Publishing to a PDS (#346) ---------------------------------------- */

  const PUBLISH_PREFS_KEY = 'hyperaudioIonospherePublish'; // { handle, did, talks: { projectId: talkUri } } — never the password
  const RECORD_COLLECTIONS = [   // everything a publish writes, talk FIRST for deletion
    'tv.ionosphere.talk',
    'tv.ionosphere.speaker',
    'pub.layers.annotation.annotationLayer',
    'pub.layers.segmentation.segmentation',
    'pub.layers.expression.expression',
    MEDIA_COLLECTION,
  ];

  // What the player holds, as a media description for the record — a URL
  // only; a blob: src is a local file with nothing to link.
  function currentMedia() {
    const player = document.getElementById('hyperplayer');
    if (player === null) return null;
    const src = player.currentSrc || player.src || '';
    if (!/^https?:\/\//.test(src)) return null;
    const media = { url: src };
    if (Number.isFinite(player.duration) && player.duration > 0) media.durationMs = Math.round(player.duration * 1000);
    const type = player.getAttribute('type');
    if (type) media.mimeType = type;
    return media;
  }
  const WRITES_PER_CALL = 200;                              // applyWrites' limit

  async function createSession(pds, identifier, password) {
    const out = await xrpc(pds + '/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: identifier, password: password }),
    });
    if (!out || !out.accessJwt) throw new Error('Sign-in did not return a session');
    return out;
  }

  // Creates, in record order (the talk comes last, after what it references).
  async function applyWrites(pds, accessJwt, did, records) {
    const writes = records.map((r) => ({
      $type: 'com.atproto.repo.applyWrites#create',
      collection: r.collection,
      rkey: r.rkey,
      value: r.value,
    }));
    let written = 0;
    for (let i = 0; i < writes.length; i += WRITES_PER_CALL) {
      const chunk = writes.slice(i, i + WRITES_PER_CALL);
      await xrpc(pds + '/xrpc/com.atproto.repo.applyWrites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessJwt },
        body: JSON.stringify({ repo: did, validate: false, writes: chunk }),
      });
      written += chunk.length;
    }
    return written;
  }

  // The whole thing: resolve, sign in, serialize against the real did, write.
  // onStep reports progress for the modal.
  async function publish(data, opts, onStep) {
    const step = typeof onStep === 'function' ? onStep : () => {};
    step('Resolving ' + opts.identifier + '…');
    const did = await resolveDid(opts.identifier);
    const pds = await resolvePds(did);
    step('Signing in to ' + pds.replace(/^https?:\/\//, '') + '…');
    const session = await createSession(pds, opts.identifier.trim().replace(/^@/, ''), opts.password);
    const repoDid = session.did || did;
    const out = transcriptJsonToIonosphere(data, {
      did: repoDid,
      rkey: generateTid(),
      title: opts.title || undefined,
      media: opts.media || null,
      createdAt: new Date().toISOString(),
    });
    step('Writing ' + out.records.length + ' records…');
    const written = await applyWrites(pds, session.accessJwt, repoDid, out.records);
    return { talkUri: out.talkUri, did: repoDid, pds: pds, written: written };
  }

  // Unpublish (#623): delete every record a publish wrote for a talk. No
  // local bookkeeping is needed to find them — every rkey in the set derives
  // from the talk's — so the set is recovered from the repo itself, by
  // listing each collection and matching the prefix, and a talk published
  // from another session or pasted in can go too. Talk first, so a partial
  // failure never leaves a talk pointing at nothing.
  const listRkeys = async (pds, did, collection) => (await listRecords(pds, did, collection)).map((r) => r.rkey);

  async function unpublish(talkUri, opts, onStep) {
    const step = typeof onStep === 'function' ? onStep : () => {};
    const talk = parseTalkUri(talkUri);
    if (talk === null) throw new Error('That is not a talk URI (at://did…/tv.ionosphere.talk/…)');
    step('Signing in…');
    const identifier = String(opts.identifier || '').trim().replace(/^@/, '');
    const pds = await resolvePds(talk.did);
    const session = await createSession(pds, identifier, opts.password);
    if (session.did && session.did !== talk.did) {
      throw new Error('That talk is in another repository (' + talk.did + '), not ' + identifier + "'s");
    }
    step('Finding the talk\u2019s records…');
    const deletes = [];
    for (const collection of RECORD_COLLECTIONS) {
      (await listRkeys(pds, talk.did, collection)).forEach((rkey) => {
        if (rkey === talk.rkey || rkey.startsWith(talk.rkey + '-')) {
          deletes.push({ $type: 'com.atproto.repo.applyWrites#delete', collection: collection, rkey: rkey });
        }
      });
    }
    if (deletes.length === 0) throw new Error('Nothing found for that talk — already unpublished?');
    step('Deleting ' + deletes.length + ' records…');
    for (let i = 0; i < deletes.length; i += WRITES_PER_CALL) {
      await xrpc(pds + '/xrpc/com.atproto.repo.applyWrites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.accessJwt },
        body: JSON.stringify({ repo: talk.did, writes: deletes.slice(i, i + WRITES_PER_CALL) }),
      });
    }
    return { talkUri: talkUri.trim(), deleted: deletes.length };
  }

  function ensureImportModal() {
    let toggle = document.getElementById('ionosphere-import-modal');
    if (toggle !== null) return toggle;
    const frag = document.createElement('div');
    frag.innerHTML =
      '<input type="checkbox" id="ionosphere-import-modal" class="modal-toggle" tabindex="-1" aria-hidden="true" />'
      + '<div class="modal"><div class="modal-box relative" style="max-width:28rem">'
      + '<label for="ionosphere-import-modal" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">✕</label>'
      + '<h3 class="text-lg font-bold">Import an ionosphere talk</h3>'
      + '<p style="margin-top:8px; font-size:0.9rem; opacity:0.75">Reads a talk\u2019s records from its repository and rebuilds the transcript here, words, timings and paragraphs, with its media when the talk links one. Repositories are public, so no sign-in is needed.</p>'
      + '<form id="ionosphere-import-form" style="display:flex; flex-direction:column; gap:12px; margin-top:16px">'
      + '<input id="ionosphere-import-uri" type="text" placeholder="at://did:plc:…/tv.ionosphere.talk/…" class="input input-bordered w-full" style="font-family:monospace" />'
      + '<p id="ionosphere-import-status" role="status" aria-live="polite" style="min-height:1.4em; font-size:0.9rem; margin:0; overflow-wrap:anywhere"></p>'
      + '<div class="modal-action" style="margin-top:4px"><label for="ionosphere-import-modal" class="btn">Cancel</label>'
      + '<button type="submit" id="ionosphere-import-btn" class="btn btn-primary">Import</button></div>'
      + '</form></div></div>';
    document.body.appendChild(frag);
    toggle = document.getElementById('ionosphere-import-modal');
    const uriEl = document.getElementById('ionosphere-import-uri');
    const status = document.getElementById('ionosphere-import-status');
    const btn = document.getElementById('ionosphere-import-btn');
    toggle.addEventListener('change', () => {
      if (!toggle.checked) return;
      status.textContent = '';
      status.style.color = '';
      btn.disabled = false;
    });
    document.getElementById('ionosphere-import-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const hypertranscript = document.getElementById('hypertranscript');
      if (hypertranscript === null || typeof jsonToHTML !== 'function') {
        status.textContent = 'You can only import into the transcript view.';
        return;
      }
      if (!uriEl.value.trim()) { status.textContent = 'Enter the talk URI.'; return; }
      btn.disabled = true;
      status.style.color = '';
      try {
        const talk = await fetchTalk(uriEl.value, (msg) => { status.textContent = msg; });
        // the same door the JSON import uses: clear a stale transcription
        // identity, paint the transcript, announce it so it becomes a project
        if (typeof window.clearPendingTranscription === 'function') window.clearPendingTranscription();
        hypertranscript.innerHTML = jsonToHTML(talk.data);
        // the talk's media, when its expression names one (mediaRef → media
        // record → url): on the player before the birth, as the JSON import does
        if (talk.media && talk.media.url) document.getElementById('hyperplayer').src = talk.media.url;
        document.dispatchEvent(new CustomEvent('hyperaudioInit'));
        rememberTalk(uriEl.value.trim());
        status.textContent = 'Imported ' + talk.data.words.length + ' words in ' + talk.data.paragraphs.length + ' paragraphs'
          + (talk.title ? ' — ' + talk.title : '') + (talk.media && talk.media.url ? '.' : '. Open its media to play along.');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
      } catch (err) {
        status.style.color = 'oklch(var(--er))';
        status.textContent = 'Could not import: ' + (err && err.message ? err.message : String(err));
        btn.disabled = false;
      }
    });
    return toggle;
  }

  class ImportIonosphere extends HTMLElement {
    connectedCallback() {
      ensureImportModal();
      this.innerHTML = '<label for="ionosphere-import-modal">Ionosphere (AT Protocol) talk</label>';
    }
  }
  customElements.define('import-ionosphere', ImportIonosphere);

  // The static viewer (#624) is a sibling of the editor, so a relative link
  // reaches it wherever the editor is served from.
  const viewerUrl = (talkUri) => 'viewer/?talk=' + encodeURIComponent(talkUri);

  // A status line with a "View it" link after the text — the viewer opens in
  // a new tab, leaving the editor where it is.
  function showWithViewLink(statusEl, text, talkUri) {
    statusEl.textContent = text + ' ';
    const a = document.createElement('a');
    a.id = 'ionosphere-view-link';
    a.href = viewerUrl(talkUri);
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'View it';
    a.className = 'link link-primary';
    statusEl.appendChild(a);
  }

  function readPublishPrefs() {
    try { return JSON.parse(localStorage.getItem(PUBLISH_PREFS_KEY)) || {}; } catch (e) { return {}; }
  }
  function writePublishPrefs(prefs) {
    try { localStorage.setItem(PUBLISH_PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  }
  // The handle, and the did it resolved to: once a publish has established
  // who the user is, the JSON export can carry the real did instead of the
  // placeholder, so the downloaded file is publishable as it stands.
  function rememberIdentity(handle, did) {
    const prefs = readPublishPrefs();
    prefs.handle = handle;
    prefs.did = did;
    writePublishPrefs(prefs);
  }
  // The talk each project was last published as — app state, not the
  // project's, so it stays out of the .hyperaudio file — so reopening the
  // modal on a published project offers its unpublish without pasting.
  const currentProjectId = () => {
    const lib = window.HyperaudioSave && window.HyperaudioSave.library;
    try { return lib && typeof lib.currentId === 'function' ? lib.currentId() : null; } catch (e) { return null; }
  };
  function rememberTalk(talkUri) {
    const id = currentProjectId();
    if (id === null) return;
    const prefs = readPublishPrefs();
    prefs.talks = prefs.talks || {};
    if (talkUri) prefs.talks[String(id)] = talkUri; else delete prefs.talks[String(id)];
    writePublishPrefs(prefs);
  }
  function rememberedTalk() {
    const id = currentProjectId();
    const talks = readPublishPrefs().talks || {};
    return id !== null && typeof talks[String(id)] === 'string' ? talks[String(id)] : '';
  }
  function knownDid() {
    const did = readPublishPrefs().did;
    return typeof did === 'string' && did.startsWith('did:') ? did : null;
  }

  const EYE_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_CLOSED = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';

  // The modal, built here so the feature stays one file. Same DaisyUI
  // modal-toggle idiom as the rest of the app: a11y.js wires the label
  // buttons, Escape and the ✕ close it.
  function ensurePublishModal() {
    let toggle = document.getElementById('ionosphere-publish-modal');
    if (toggle !== null) return toggle;
    const frag = document.createElement('div');
    frag.innerHTML =
      '<input type="checkbox" id="ionosphere-publish-modal" class="modal-toggle" tabindex="-1" aria-hidden="true" />'
      + '<div class="modal"><div class="modal-box relative" style="max-width:28rem">'
      + '<label for="ionosphere-publish-modal" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">✕</label>'
      + '<h3 class="text-lg font-bold">Publish to your PDS</h3>'
      + '<p style="margin-top:8px; font-size:0.9rem; opacity:0.75">Writes this transcript to your AT Protocol repository as ionosphere records, under your own account. Sign in with an app password, not your main one — you can make one in your account settings and revoke it at any time. It is used for this publish only and never stored.</p>'
      + '<form id="ionosphere-publish-form" style="display:flex; flex-direction:column; gap:12px; margin-top:16px">'
      + '<input id="ionosphere-handle" type="text" autocomplete="username" placeholder="Handle, e.g. you.bsky.social" class="input input-bordered w-full" />'
      + '<div class="key-field" style="max-width:none"><input id="ionosphere-app-password" type="password" autocomplete="current-password" placeholder="App password" class="input input-bordered w-full" />'
      + '<button type="button" class="key-eye" id="ionosphere-eye" data-wired="1" aria-label="Show password" tabindex="-1"><span class="eye-open">' + EYE_OPEN + '</span><span class="eye-closed" style="display:none">' + EYE_CLOSED + '</span></button></div>'
      + '<input id="ionosphere-title" type="text" placeholder="Talk title (optional)" class="input input-bordered w-full" />'
      + '<p id="ionosphere-publish-status" role="status" aria-live="polite" style="min-height:1.4em; font-size:0.9rem; margin:0; overflow-wrap:anywhere"></p>'
      + '<div class="modal-action" style="margin-top:4px"><label for="ionosphere-publish-modal" class="btn">Cancel</label>'
      + '<button type="submit" id="ionosphere-publish-btn" class="btn btn-primary">Publish</button></div>'
      + '<div style="margin-top:8px; padding-top:12px; border-top:1px solid oklch(var(--bc) / 0.12)">'
      + '<p style="font-size:0.9rem; opacity:0.75; margin:0 0 8px">Unpublish removes every record of a talk from your repository. Sign in above, then give the talk\u2019s URI — the one just published, or this project\u2019s last one, is filled in.</p>'
      + '<div style="display:flex; gap:8px; align-items:center"><input id="ionosphere-talk-uri" type="text" placeholder="at://did:plc:…/tv.ionosphere.talk/…" class="input input-bordered input-sm w-full" style="font-family:monospace" />'
      + '<button type="button" id="ionosphere-unpublish-btn" class="btn btn-sm btn-outline btn-error" style="flex:0 0 auto">Unpublish</button></div>'
      + '</div>'
      + '</form></div></div>';
    document.body.appendChild(frag);
    toggle = document.getElementById('ionosphere-publish-modal');

    const handleEl = document.getElementById('ionosphere-handle');
    const passEl = document.getElementById('ionosphere-app-password');
    const titleEl = document.getElementById('ionosphere-title');
    const status = document.getElementById('ionosphere-publish-status');
    const btn = document.getElementById('ionosphere-publish-btn');
    const uriEl = document.getElementById('ionosphere-talk-uri');
    const unpublishBtn = document.getElementById('ionosphere-unpublish-btn');

    // data-wired="1" on the button keeps transcribe-prefs' own eye wiring off
    // it: two handlers toggled the field twice and it never revealed.
    document.getElementById('ionosphere-eye').addEventListener('click', (e) => {
      const reveal = passEl.type === 'password';
      passEl.type = reveal ? 'text' : 'password';
      e.currentTarget.querySelector('.eye-open').style.display = reveal ? 'none' : '';
      e.currentTarget.querySelector('.eye-closed').style.display = reveal ? '' : 'none';
      e.currentTarget.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    });

    // Opening: prefill the handle and the title; the password is always empty.
    toggle.addEventListener('change', () => {
      if (!toggle.checked) return;
      handleEl.value = readPublishPrefs().handle || '';
      passEl.value = '';
      const save = window.HyperaudioSave;
      titleEl.value = save && typeof save.getProjectTitle === 'function' ? (save.getProjectTitle() || '') : '';
      status.textContent = '';
      status.style.color = '';
      btn.disabled = false;
      uriEl.value = rememberedTalk();
      unpublishBtn.disabled = false;
      if (uriEl.value) showWithViewLink(status, 'Last published from this project.', uriEl.value);
    });

    unpublishBtn.addEventListener('click', async () => {
      if (!handleEl.value.trim() || !passEl.value) {
        status.style.color = '';
        status.textContent = 'Enter your handle and an app password.';
        return;
      }
      if (!uriEl.value.trim()) {
        status.style.color = '';
        status.textContent = 'Enter the talk URI to unpublish.';
        return;
      }
      unpublishBtn.disabled = true;
      btn.disabled = true;
      status.style.color = '';
      try {
        const result = await unpublish(uriEl.value, { identifier: handleEl.value, password: passEl.value }, (msg) => { status.textContent = msg; });
        if (rememberedTalk() === result.talkUri) rememberTalk(null);
        uriEl.value = '';
        status.textContent = 'Unpublished: ' + result.deleted + ' records removed.';
      } catch (err) {
        status.style.color = 'oklch(var(--er))';
        status.textContent = 'Could not unpublish: ' + (err && err.message ? err.message : String(err));
      } finally {
        passEl.value = '';
        unpublishBtn.disabled = false;
        btn.disabled = false;
      }
    });

    document.getElementById('ionosphere-publish-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const hypertranscript = document.getElementById('hypertranscript');
      const data = hypertranscript !== null && typeof htmlToJSON === 'function' ? htmlToJSON(hypertranscript.innerHTML) : null;
      if (!data || !data.words || data.words.length === 0) {
        status.textContent = 'There is no transcript to publish.';
        return;
      }
      if (!handleEl.value.trim() || !passEl.value) {
        status.textContent = 'Enter your handle and an app password.';
        return;
      }
      btn.disabled = true;
      status.style.color = '';
      try {
        const result = await publish(data, {
          identifier: handleEl.value,
          password: passEl.value,
          title: titleEl.value.trim(),
          media: currentMedia(),
        }, (msg) => { status.textContent = msg; });
        rememberIdentity(handleEl.value.trim().replace(/^@/, ''), result.did);
        rememberTalk(result.talkUri);
        uriEl.value = result.talkUri;   // ready to take back
        showWithViewLink(status, 'Published ' + result.written + ' records. Talk: ' + result.talkUri + '.', result.talkUri);
      } catch (err) {
        status.style.color = 'oklch(var(--er))';
        status.textContent = 'Could not publish: ' + (err && err.message ? err.message : String(err));
        btn.disabled = false;
      } finally {
        passEl.value = ''; // never kept beyond the attempt
      }
    });
    return toggle;
  }

  class PublishIonosphere extends HTMLElement {
    connectedCallback() {
      ensurePublishModal();
      this.innerHTML = '<label for="ionosphere-publish-modal">Publish to PDS…</label>';
    }
  }
  customElements.define('publish-ionosphere', PublishIonosphere);

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
        did: knownDid() || PLACEHOLDER_DID,   // the user's own did once a publish has resolved it
        rkey: generateTid(),
        media: currentMedia(),
        createdAt: new Date().toISOString(),
      });
      downloadJsonFile(out, 'ionosphere-records.json');
    }

    connectedCallback() {
      this.innerHTML = '<a>Ionosphere (AT Protocol) JSON</a>';
      this.addEventListener('click', this.exportIonosphere);
    }
  }

  customElements.define('export-ionosphere', ExportIonosphere);

  // Expose the pure serializer for reuse/testing without the DOM/menu, and
  // the publish pieces for the same reason.
  window.transcriptJsonToIonosphere = transcriptJsonToIonosphere;
  window.IonospherePublish = Object.freeze({ resolveDid, resolvePds, createSession, applyWrites, publish, unpublish, fetchTalk, parseTalkUri, knownDid, WRITES_PER_CALL });
})();

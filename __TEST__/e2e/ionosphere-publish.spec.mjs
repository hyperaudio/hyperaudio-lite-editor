// #346 — publishing the ionosphere record set to the user's own PDS: resolve
// the handle to a did and the did to its PDS, sign in with an app password,
// serialize against the REAL did (no placeholder), and write the records with
// applyWrites in chunks of 200. The network is mocked at the page: what the
// module sends is the thing under test.
import { test, expect } from '@playwright/test';

const DID = 'did:plc:abc123abc123abc123abc123';
const PDS = 'https://pds.example';

// A fake PDS. Returns the captured calls for assertions.
async function mockNetwork(page, { badPassword = false } = {}) {
  const calls = { session: [], writes: [] };
  await page.route('https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle*', (route) => {
    const handle = new URL(route.request().url()).searchParams.get('handle');
    route.fulfill({ json: handle === 'mark.example.com' ? { did: DID } : { error: 'InvalidRequest', message: 'Unable to resolve handle' }, status: handle === 'mark.example.com' ? 200 : 400 });
  });
  await page.route('https://plc.directory/*', (route) => route.fulfill({ json: {
    id: DID, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS + '/' }],
  } }));
  await page.route(PDS + '/xrpc/com.atproto.server.createSession', (route) => {
    const body = route.request().postDataJSON();
    calls.session.push(body);
    if (badPassword) return route.fulfill({ status: 401, json: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' } });
    route.fulfill({ json: { accessJwt: 'jwt-1', refreshJwt: 'r', did: DID, handle: body.identifier } });
  });
  await page.route(PDS + '/xrpc/com.atproto.repo.applyWrites', (route) => {
    calls.writes.push({ auth: route.request().headers().authorization, body: route.request().postDataJSON() });
    route.fulfill({ json: { results: [] } });
  });
  // the repo as a publish leaves it, plus a decoy talk that must survive
  const repo = {
    'tv.ionosphere.talk': ['3mvi355ibkkvn', '3mvi999decoyz'],
    'tv.ionosphere.speaker': ['3mvi355ibkkvn-speaker-mark', '3mvi999decoyz-speaker-mark'],
    'pub.layers.annotation.annotationLayer': ['3mvi355ibkkvn-paragraphs'],
    'pub.layers.segmentation.segmentation': ['3mvi355ibkkvn-segmentation-1', '3mvi355ibkkvn-temporal-1', '3mvi999decoyz-temporal-1'],
    'pub.layers.expression.expression': ['3mvi355ibkkvn-expression', '3mvi999decoyz-expression'],
    'io.hyperaud.media': ['3mvi355ibkkvn-media', '3mvi999decoyz-media'],
  };
  await page.route(PDS + '/xrpc/com.atproto.repo.listRecords*', (route) => {
    const u = new URL(route.request().url());
    const col = u.searchParams.get('collection');
    route.fulfill({ json: { records: (repo[col] || []).map((rkey) => ({ uri: 'at://' + DID + '/' + col + '/' + rkey, value: {} })) } });
  });
  return calls;
}

const openPublish = async (page) => {
  await page.evaluate(() => {
    const m = document.getElementById('ionosphere-publish-modal');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
  });
};

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('publishes the record set to the resolved PDS under the real did, talk last', async ({ page }) => {
  const calls = await mockNetwork(page);
  expect(await page.evaluate(() => !!document.querySelector('#file-export-submenu publish-ionosphere label[for="ionosphere-publish-modal"]'))).toBe(true);

  await openPublish(page);
  await expect(page.locator('#ionosphere-title')).toHaveValue('How to use the Editor');   // prefilled from the project
  await page.fill('#ionosphere-handle', '@mark.example.com');
  await page.fill('#ionosphere-app-password', 'abcd-efgh-ijkl-mnop');
  // the eye reveals and hides (transcribe-prefs wires every .key-eye too; this one must not be double-toggled)
  await page.click('#ionosphere-eye');
  await expect(page.locator('#ionosphere-app-password')).toHaveAttribute('type', 'text');
  await page.click('#ionosphere-eye');
  await expect(page.locator('#ionosphere-app-password')).toHaveAttribute('type', 'password');
  await page.fill('#ionosphere-title', 'A talk');
  await page.click('#ionosphere-publish-btn');
  await expect(page.locator('#ionosphere-publish-status')).toHaveText(new RegExp('^Published 7 records\\. Talk: at://' + DID + '/tv\\.ionosphere\\.talk/[a-z2-7]{13}$'));

  expect(calls.session).toEqual([{ identifier: 'mark.example.com', password: 'abcd-efgh-ijkl-mnop' }]);
  expect(calls.writes).toHaveLength(1);
  const { auth, body } = calls.writes[0];
  expect(auth).toBe('Bearer jwt-1');
  expect(body.repo).toBe(DID);
  expect(body.validate).toBe(false);
  expect(body.writes.map((w) => w.$type)).toEqual(Array(7).fill('com.atproto.repo.applyWrites#create'));
  expect(body.writes.map((w) => w.collection)).toEqual([
    'io.hyperaud.media',             // the intro's media is a URL, so it gets a record…
    'pub.layers.expression.expression',
    'pub.layers.segmentation.segmentation',
    'pub.layers.segmentation.segmentation',
    'pub.layers.annotation.annotationLayer',
    'tv.ionosphere.speaker',
    'tv.ionosphere.talk',
  ]);
  expect(JSON.stringify(body)).not.toContain('REPLACE_ME');
  const talk = body.writes[6].value;
  expect(talk.title).toBe('A talk');
  expect(talk.speakerUris).toEqual(['at://' + DID + '/tv.ionosphere.speaker/' + body.writes[5].rkey]);
  // …and the expression points at it, one hop
  const mediaRec = body.writes[0];
  expect(mediaRec.value.url).toBe('https://lab.hyperaud.io/audio/HLEintroAudio.mp3');
  expect(mediaRec.value.mimeType).toBe('audio/mpeg');
  expect(body.writes[1].value.mediaRef).toBe('at://' + DID + '/io.hyperaud.media/' + mediaRec.rkey);
  expect(mediaRec.rkey).toBe(body.writes[6].rkey + '-media');

  // the password is not kept; the handle and its did are
  expect(await page.evaluate(() => document.getElementById('ionosphere-app-password').value)).toBe('');
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await openPublish(page);
  await expect(page.locator('#ionosphere-handle')).toHaveValue('mark.example.com');
  await expect(page.locator('#ionosphere-app-password')).toHaveValue('');
  expect(await page.evaluate(() => window.IonospherePublish.knownDid())).toBe(DID);
});

test('the JSON export carries the real did once one is known, the placeholder before', async ({ page, context }) => {
  const exported = async () => {
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => document.querySelector('export-ionosphere a').click()),
    ]);
    const path = await dl.path();
    return JSON.parse((await import('node:fs')).readFileSync(path, 'utf8'));
  };
  expect((await exported()).did).toBe('did:plc:REPLACE_ME');

  // as a publish leaves things
  await page.evaluate((did) => localStorage.setItem('hyperaudioIonospherePublish', JSON.stringify({ handle: 'mark.example.com', did })), DID);
  const out = await exported();
  expect(out.did).toBe(DID);
  expect(out.talkUri.startsWith('at://' + DID + '/')).toBe(true);
  expect(JSON.stringify(out)).not.toContain('REPLACE_ME');
});

test('a failed sign-in is reported and nothing is written', async ({ page }) => {
  const calls = await mockNetwork(page, { badPassword: true });
  await openPublish(page);
  await page.fill('#ionosphere-handle', 'mark.example.com');
  await page.fill('#ionosphere-app-password', 'wrong');
  await page.click('#ionosphere-publish-btn');
  await expect(page.locator('#ionosphere-publish-status')).toHaveText('Could not publish: Invalid identifier or password');
  expect(calls.writes).toHaveLength(0);
  await expect(page.locator('#ionosphere-publish-btn')).toBeEnabled();   // try again
});

test('writes go in chunks of 200, the endpoint limit', async ({ page }) => {
  const calls = await mockNetwork(page);
  const written = await page.evaluate(async ([pds, did]) => {
    const records = Array.from({ length: 450 }, (_, i) => ({ collection: 'x.test', rkey: 'r' + i, value: { $type: 'x.test', i } }));
    return window.IonospherePublish.applyWrites(pds, 'jwt-1', did, records);
  }, [PDS, DID]);
  expect(written).toBe(450);
  expect(calls.writes.map((c) => c.body.writes.length)).toEqual([200, 200, 50]);
  expect(calls.writes[2].body.writes[49].rkey).toBe('r449');
});

test('unpublish deletes every record of the talk, talk first, and nothing else (#623)', async ({ page }) => {
  const calls = await mockNetwork(page);
  await openPublish(page);
  await page.fill('#ionosphere-handle', 'mark.example.com');
  await page.fill('#ionosphere-app-password', 'abcd-efgh-ijkl-mnop');
  await page.fill('#ionosphere-talk-uri', 'at://' + DID + '/tv.ionosphere.talk/3mvi355ibkkvn');
  await page.click('#ionosphere-unpublish-btn');
  await expect(page.locator('#ionosphere-publish-status')).toHaveText('Unpublished: 7 records removed.');

  expect(calls.writes).toHaveLength(1);
  const { auth, body } = calls.writes[0];
  expect(auth).toBe('Bearer jwt-1');
  expect(body.repo).toBe(DID);
  expect(body.writes.every((w) => w.$type === 'com.atproto.repo.applyWrites#delete')).toBe(true);
  expect(body.writes.map((w) => w.rkey)).toEqual([
    '3mvi355ibkkvn',                 // the talk goes first
    '3mvi355ibkkvn-speaker-mark',
    '3mvi355ibkkvn-paragraphs',
    '3mvi355ibkkvn-segmentation-1',
    '3mvi355ibkkvn-temporal-1',
    '3mvi355ibkkvn-expression',
    '3mvi355ibkkvn-media',
  ]);
  expect(JSON.stringify(body)).not.toContain('decoy');
  await expect(page.locator('#ionosphere-app-password')).toHaveValue('');
});

test('a talk in another repository is refused before anything is listed or deleted', async ({ page }) => {
  const calls = await mockNetwork(page);
  await openPublish(page);
  await page.fill('#ionosphere-handle', 'mark.example.com');
  await page.fill('#ionosphere-app-password', 'abcd-efgh-ijkl-mnop');
  await page.fill('#ionosphere-talk-uri', 'at://did:plc:someoneelse00000000000/tv.ionosphere.talk/3mvi355ibkkvn');
  await page.click('#ionosphere-unpublish-btn');
  await expect(page.locator('#ionosphere-publish-status')).toHaveText(/^Could not unpublish: That talk is in another repository/);
  expect(calls.writes).toHaveLength(0);
});

test('the talk just published is offered for unpublish, and remembered per project (#623)', async ({ page }) => {
  await mockNetwork(page);
  await openPublish(page);
  await page.fill('#ionosphere-handle', 'mark.example.com');
  await page.fill('#ionosphere-app-password', 'abcd-efgh-ijkl-mnop');
  await page.click('#ionosphere-publish-btn');
  await expect(page.locator('#ionosphere-publish-status')).toHaveText(/^Published 7 records/);
  const uri = await page.inputValue('#ionosphere-talk-uri');
  expect(uri.startsWith('at://' + DID + '/tv.ionosphere.talk/')).toBe(true);

  // reopen on the same project: still offered
  await page.reload();
  await page.waitForSelector('#hypertranscript [data-m]');
  await openPublish(page);
  await expect(page.locator('#ionosphere-talk-uri')).toHaveValue(uri);
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('hyperaudioIonospherePublish')).talks))).toHaveLength(1);
});

// Reading back (#346): a mocked repo served from the serializer's own output,
// so what the reader rebuilds can be compared with what was published.
const SAMPLE = {
  words: [
    { start: 1.44, end: 2.0, text: 'Hello' },
    { start: 2.0, end: 2.3, text: 'café' },              // non-ASCII: UTF-8 offsets
    { start: 2.5, end: 2.7, text: 'speech', space: false }, // glued split word
    { start: 2.7, end: 2.9, text: '-to', space: false },
    { start: 2.9, end: 3.0, text: '-text' },
    { start: 4.0, end: 4.5, text: 'Second' },
    { start: 4.5, end: 5.0, text: 'paragraph.' },
  ],
  // the speaker is labelled where it changes — on the first paragraph only
  paragraphs: [{ start: 1.44, end: 3.0, speaker: 'Mark' }, { start: 4.0, end: 5.0 }],
};

async function mockRepoFrom(page, data, rkey, media) {
  const exp = await page.evaluate(([d, rk, did, media]) => window.transcriptJsonToIonosphere(d, { did, rkey: rk, createdAt: '2026-01-01T00:00:00.000Z', title: 'Round trip', media }), [data, rkey, DID, media || null]);
  await page.route('https://plc.directory/*', (route) => route.fulfill({ json: { id: DID, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] } }));
  await page.route(PDS + '/xrpc/com.atproto.repo.getRecord*', (route) => {
    const u = new URL(route.request().url());
    const r = exp.records.find((x) => x.collection === u.searchParams.get('collection') && x.rkey === u.searchParams.get('rkey'));
    if (!r) return route.fulfill({ status: 400, json: { error: 'RecordNotFound', message: 'Could not locate record' } });
    route.fulfill({ json: { uri: 'at://' + DID + '/' + r.collection + '/' + r.rkey, value: r.value } });
  });
  await page.route(PDS + '/xrpc/com.atproto.repo.listRecords*', (route) => {
    const col = new URL(route.request().url()).searchParams.get('collection');
    route.fulfill({ json: { records: exp.records.filter((x) => x.collection === col).map((x) => ({ uri: 'at://' + DID + '/' + col + '/' + x.rkey, value: x.value })) } });
  });
  return exp;
}

test('import rebuilds the transcript from the repo: words, UTF-8 text, glued words, paragraphs, speaker', async ({ page }) => {
  const exp = await mockRepoFrom(page, SAMPLE, '3mvi355ibkkvn');
  expect(await page.evaluate(() => !!document.querySelector('#file-import-submenu import-ionosphere label[for="ionosphere-import-modal"]'))).toBe(true);

  const back = await page.evaluate((uri) => window.IonospherePublish.fetchTalk(uri), exp.talkUri);
  expect(back.title).toBe('Round trip');
  expect(back.data).toEqual(SAMPLE);
  expect(back.media).toBeNull();   // no media given: no record, no mediaRef

  // and through the modal, into the editor as a project
  await page.evaluate(() => { const m = document.getElementById('ionosphere-import-modal'); m.checked = true; m.dispatchEvent(new Event('change')); });
  await page.fill('#ionosphere-import-uri', exp.talkUri);
  await page.click('#ionosphere-import-btn');
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')].map((s) => s.textContent).join('|')))
    .toBe('Hello |café |speech|-to|-text |Second |paragraph. ');
  expect(await page.evaluate(() => document.querySelectorAll('#hypertranscript p').length)).toBe(2);
  expect(await page.evaluate(() => [...document.querySelectorAll('#hypertranscript span.speaker')].map((s) => s.textContent.trim()))).toEqual(['[Mark]']);
  expect(await page.evaluate(() => document.getElementById('ionosphere-import-modal').checked)).toBe(false);
  // the transcript round-trips through the editor's own converter unchanged
  expect(await page.evaluate(() => htmlToJSON(document.getElementById('hypertranscript').innerHTML))).toEqual(SAMPLE);
});

test('import of a URI with no talk behind it is reported, and the transcript untouched', async ({ page }) => {
  await mockRepoFrom(page, SAMPLE, '3mvi355ibkkvn');
  const before = await page.evaluate(() => document.getElementById('hypertranscript').innerHTML);
  await page.evaluate(() => { const m = document.getElementById('ionosphere-import-modal'); m.checked = true; m.dispatchEvent(new Event('change')); });
  await page.fill('#ionosphere-import-uri', 'at://' + DID + '/tv.ionosphere.talk/3mvi999nothere');
  await page.click('#ionosphere-import-btn');
  await expect(page.locator('#ionosphere-import-status')).toHaveText(/^Could not import: /);
  expect(await page.evaluate(() => document.getElementById('hypertranscript').innerHTML)).toBe(before);
});

test('a talk with a media record brings its media along, into the player on import', async ({ page }) => {
  const exp = await mockRepoFrom(page, SAMPLE, '3mvi355ibkkvn', { url: 'https://media.example/talk.mp4', mimeType: 'video/mp4', durationMs: 5000 });
  const media = exp.records.find((r) => r.collection === 'io.hyperaud.media');
  expect(media.rkey).toBe('3mvi355ibkkvn-media');
  expect(exp.records.find((r) => r.collection === 'pub.layers.expression.expression').value.mediaRef)
    .toBe('at://' + DID + '/io.hyperaud.media/3mvi355ibkkvn-media');

  const back = await page.evaluate((uri) => window.IonospherePublish.fetchTalk(uri), exp.talkUri);
  expect(back.media).toEqual({ url: 'https://media.example/talk.mp4', uri: media && 'at://' + DID + '/io.hyperaud.media/3mvi355ibkkvn-media', mimeType: 'video/mp4', durationMs: 5000 });

  await page.route('https://media.example/**', (route) => route.fulfill({ status: 404 }));   // the player only needs the src set
  await page.evaluate(() => { const m = document.getElementById('ionosphere-import-modal'); m.checked = true; m.dispatchEvent(new Event('change')); });
  await page.fill('#ionosphere-import-uri', exp.talkUri);
  await page.click('#ionosphere-import-btn');
  await expect.poll(() => page.evaluate(() => document.getElementById('hyperplayer').src)).toBe('https://media.example/talk.mp4');
});

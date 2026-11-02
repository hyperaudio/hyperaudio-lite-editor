# Adding a speech-to-text engine

The editor transcribes with five engines today: Parakeet and Whisper in the
browser, and AssemblyAI, Deepgram and Parakeet through Hugging Face in the
cloud. Each one is two files, and a new engine is the same two files.

- **A converter**, `js/converters/<name>.js`. A pure function that turns the
  engine's own output into the editor's transcript. No DOM, no network, so it
  runs in node against a fixture of the engine's real output.
- **A client**, `js/hyperaudio-lite-editor-<name>.js`. The engine's tab in the
  Transcribe dialog, the connecting (upload, request, poll, or a worker), and
  the handful of calls that hand the result to the editor.

The smallest real pair to copy is `js/converters/parakeet.js` with
`js/hyperaudio-lite-editor-parakeet.js`: one POST, one response, no speakers.
Deepgram is the pair to read for speakers, summary and topics, and
`js/hyperaudio-lite-editor-whisper.js` with `js/whisper.worker.js` for an
engine that runs in the browser.

## 1. What the editor wants back

Every converter returns the same thing, the canonical transcript:

```js
{
  words: [
    { text: 'We', start: 0.08, end: 0.24, speaker: 'speaker-0' },
    { text: 'could', start: 0.24, end: 0.48, speaker: 'speaker-0' },
    // ...
  ],
  paragraphs: [
    { start: 0.08, end: 1.76, speaker: 'speaker-0' },
    { start: 1.84, end: 6.4, speaker: 'speaker-1' },
  ],
}
```

- Times are **seconds**. Convert milliseconds on the way in.
- `text` is the word as it should read, punctuation attached.
- `speaker` is optional, and when present it is a label, `speaker-` followed by
  whatever the engine uses to tell speakers apart (a number, a letter). Leave
  it off entirely when the engine does not diarize.
- `space: false` on a word means no space between it and the next one. Only
  needed when the engine glues tokens together.
- The paragraphs come from one rule shared by every engine and import
  (`js/paragraph-rule.js`): a new paragraph on a change of speaker, and on a
  long pause after a sentence end. The converter never decides paragraphs
  itself.

`jsonToHTML` in `js/html-json-converter.js` renders that into the transcript's
markup. It is the one renderer, so a converter never builds markup of its own.
The exception is `js/converters/captions.js`, where SRT and VTT cues carry
styling tags that have to survive and whose words have no durations.

## 2. The converter

`js/converters/transcript-words.js` holds what the converters share and
explains the folder. A converter is a classic script that registers itself on
`window.HyperaudioConverters` in the page and exports itself in node:

```js
/**
 * converters/acme.js
 * (C) The Hyperaudio Project
 * @version 1.3.44 — last changed in release 1.3.44
 * @license MIT
 *
 * Acme's transcript (#NNN): its word list, with times in milliseconds, as the
 * editor's canonical transcript. The client (js/hyperaudio-lite-editor-acme.js)
 * sends the request and puts the result on the page. Nothing here touches
 * the page.
 */
(function (root) {
  'use strict';

  const shared = (root && root.HyperaudioConverters) || (typeof require === 'function' ? require('./transcript-words.js') : null);

  function acme(json) {
    const words = (json.words || []).map((w) => ({
      text: w.text,
      start: w.start_ms / 1000,
      end: w.end_ms / 1000,
      speaker: 'speaker-' + w.speaker,
    }));
    const transcript = shared.transcriptFromWords(words, { labelOnChange: true });
    return {
      words: transcript.words,
      paragraphs: transcript.paragraphs,
      language: json.language || undefined,
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { acme };
  if (root) {
    root.HyperaudioConverters = root.HyperaudioConverters || {};
    root.HyperaudioConverters.acme = acme;
  }
}(typeof window !== 'undefined' ? window : null));
```

Two things to get right:

- **`transcriptFromWords(words, { labelOnChange: true })` for an engine that
  diarizes**, `transcriptFromWords(words)` for one that does not. `jsonToHTML`
  writes a speaker label at the head of every paragraph that names a speaker.
  The diarizing engines have always labelled a speaker once, at their first
  word and at each change, and not again when the same speaker's paragraph
  breaks on a pause. `labelOnChange` keeps that by leaving the speaker off a
  paragraph that follows one of the same speaker's. The words keep theirs.
- **Return whatever else the client will show**, beside `words` and
  `paragraphs`: the detected language, a summary, topics, the model build that
  answered. Read them off the response here, not in the client, so they are
  tested with the rest.

### Its test

A fixture of the engine's **real** output goes in
`__TEST__/fixtures/converters/<name>.json`, small enough to read: the existing
ones are the same 19-word, two-speaker exchange with a pause, so a new fixture
in that text makes the tests comparable. The test goes in
`__TEST__/unit/converters/<name>.test.mjs`, loads the converter with
`createRequire`, and checks at least:

- the first words, with their text, times in seconds and speaker
- the paragraphs, and that one speaker across a long pause gives a second
  paragraph with no second label
- what happens without speakers, and without the optional fields
- one render through `jsonToHTML`, counting `class="speaker"` and `<p>`

`npm run test:unit` runs it. The lane is node's own test runner, no browser,
and it takes milliseconds.

## 3. The client

The client owns the tab in the Transcribe dialog and the connecting. It never
parses the response: it hands the response to the converter and puts what
comes back on the page.

### The tab

Three pieces in `index.html`:

1. **A template** for the form, beside the others near the top of the file:
   `<template id="acme-modal-template">`. Copy the Parakeet (HF) one. The
   parts are a key field (the `key-field` wrapper gives the show and hide
   eye), a "Remember key on this device" toggle, a `<input type="file">`, a
   `<details class="url-source">` with the URL field, the model and language
   selects, and the submit, which is a `<label for="transcribe-modal">` that
   closes the dialog when clicked and is held back with the `btn-disabled`
   class until there is a key and a file or URL.
2. **A tab** in `#local-group` or `#cloud-group` in the Transcribe modal: a
   radio with `name="local_tabs"` or `name="cloud_tabs"` and an `aria-label`,
   which is the name the dialog remembers the chosen engine by, then a
   `tab-content` div holding the custom element.
3. **The custom element** itself, `<acme-service templateSelector="#acme-modal-template">`.
   Its `connectedCallback` copies the template in, removes the template, fills
   the selects and wires the listeners, as every client does.

Give every input an id that starts with the engine's name
(`acme-key`, `acme-file`, `acme-media`, `acme-model`, `acme-language`,
`acme-remember-key`, `acme-submit-btn`). Then put those ids where the editor
keeps its lists, or four things silently fail:

- `js/editor-core.js`, the list of file inputs whose value is cleared on
  click. Without it, picking the same file twice fires no change event and
  the second transcription is a no-op (#525).
- `js/hyperaudio-save.js`, `wireCapture()`, the list of file inputs the
  project library watches to learn the media file. Without it the new project
  has a transcript and no media.
- `js/transcribe-prefs.js`, `MODEL_IDS`, `VALUE_IDS`, `CHECK_IDS` and
  `REMEMBER_MAP`. Without them the dialog forgets the key, the model and the
  language between sessions. A key is only kept while its remember toggle is
  on, and Settings ▸ Forget clears it.
- `js/transcribe-from-project.js`, `FILE_INPUTS` and `URL_INPUTS`. Transcribe
  again on a Recents row (#677) puts the project's media into every engine's
  inputs, and an engine missing from those lists opens with nothing chosen.

An option that is not ready for everyone can carry `data-experimental`: it
stays out of the page until Settings ▸ Application ▸ Experimental features is
on (`js/experimental-features.js`).

### The engine contract

The editor learns about a transcription only through these calls, in this
order. The project library hangs its behaviour off them (the in-progress row
in Recents, the identity of the new project, what happens when the user
switches away), so the order matters. The calls are shown bare here, and
guarded in the clients, as the note after the second sample says.

```js
getData() {
  // 1. leave caption mode, so the loader and the result land in the transcript
  document.querySelector('#transcript-editor-btn')?.click();

  // 2. the media on the player FIRST: the library captures what is being
  //    transcribed at the busy signal, from the player
  const player = document.querySelector('#hyperplayer');
  player.src = file !== undefined ? URL.createObjectURL(file) : mediaUrl;

  // 3. the loader, as a notice, with a .transcribing-msg for progress text
  showTranscriptNotice('<div class="vertically-centre"><center class="transcribing-msg">Transcribing…</center><br/>'
    + '<img src="' + transcribingSvg + '" width="50" alt="transcribing" style="margin: auto; display: block;"></div>');

  // 4. the busy signal: editing off, the in-progress row appears in Recents
  setTranscriptBusy(true);

  run(file, mediaUrl, options).catch(showError);
}
```

Then, when the result arrives:

```js
function finish(json) {
  const converted = window.HyperaudioConverters.acme(json);
  const html = jsonToHTML({ words: converted.words, paragraphs: converted.paragraphs });
  const info = { ...meta, seconds: (Date.now() - startedAt) / 1000 };

  // 5. the user may have opened another project meanwhile (#715): then the
  //    screen is theirs, and the result goes to Recents as a project of its own
  const background = window.hyperaudioTranscriptionInBackground();
  if (!background) {
    const track = document.querySelector('#hyperplayer-vtt');   // only the on-screen path touches the page
    track.label = converted.language;
    track.srcLang = converted.language;
  }
  if (window.hyperaudioKeepTranscription({ html, info })) return;   // taken: touch nothing more

  // 6. on screen: the transcript, the details, busy off, and the two events
  document.querySelector('#hypertranscript').innerHTML = html;
  setTranscriptionInfo(info);
  setTranscriptBusy(false);
  document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  document.dispatchEvent(new CustomEvent('hyperaudioGenerateCaptionsFromTranscript'));
}
```

`hyperaudioInit` is the birth of the project: the library gives it an id,
writes the transcript as its origin and the media as its own, and the editor
indexes the words. `hyperaudioGenerateCaptionsFromTranscript` makes the
captions from it. Pass `summary` and `topics` to `hyperaudioKeepTranscription`
too when the engine has them, and write them into `#summary` and `#topics` on
the on-screen path, as the Deepgram client does.

The existing clients guard every call with `typeof setTranscriptBusy === 'function'`
because the contract's functions load later in the page than the clients do.
Keep the guards.

### Errors

An engine that ends without a transcript must still call
`setTranscriptBusy(false)`. The library reads busy off with no timed words in
the transcript as a failure, and takes the in-progress row down. Paint the
error through `showTranscriptNotice` with `errorSvg`, never straight into
`innerHTML`: a notice is marked not editable and not a document, so a
keystroke in it cannot be autosaved over the open project (#628). Map the
engine's status codes to plain messages (bad key, quota, unreadable media,
service down), as `displayParakeetHfError` does.

### What `info` carries

`setTranscriptionInfo(info)` fills Project info, and the library turns the
same object into the project's provenance, which the TPME sidecar can later
describe (#668). Fields:

| Field | Shown as | Example |
|---|---|---|
| `service` | Service | `"Acme (cloud)"` |
| `model` | Model | `"Acme Large v2"` |
| `language` | Language | the option's label, `"English"` |
| `languageCode` | the project's language tag | `"en"` |
| `device` | Processing | `"GPU (WebGPU)"`, local engines only |
| `seconds` | Time taken | `42.3` |
| `modelId` | provenance only | `"acme/large-v2"` |
| `engineVersion` | provenance only | the build the service names, if it does |
| `runtime` | provenance only | `"onnxruntime-web"` or `"transformers.js"`, local engines |
| `parameters` | provenance only | exactly what was asked for, as plain data |

`parameters` is what was really sent: the model, the language or detection
flag, diarization on or off. **Never a key or a token.** Build `info` when the
run starts (the choices) and add `seconds` when it ends.

### A URL that resolves late

An engine that only learns its media address after starting (an HLS playlist
that resolves to a stream, a service that returns the stored copy) reports it
with `window.hyperaudioUpdatePendingMediaSrc(url)`, so the new project is
named and paired with the right media.

## 4. An engine that runs in the browser

A local engine has the same converter and the same contract, with a worker in
between. `js/hyperaudio-lite-editor-parakeet-local.js` with
`js/parakeet.worker.js` and the Whisper pair are the models. What they add:

- **The worker's path carries the cache-bust** in the client,
  `workerBaseUrl + "js/acme.worker.js?v=1.3.44"`, bumped like a script tag.
- **Device choice** lives in the worker. A usable GPU is one that answers
  `requestAdapter()` (and, for an fp16 model, exposes `shader-f16`), and the
  WASM path is the fallback. Firefox prefers WASM because its WebGPU is far
  slower than its CPU path, and Parakeet keeps Safari on the CPU because its
  encoder exhausted Safari's memory. Report the device back so the client can
  show it and put it in `info.device`.
- **Progress** goes into the loader's `.transcribing-msg`. The client keeps
  that element's identity: the library moves the loader's live nodes aside
  when the user switches away and puts the same nodes back when they return,
  so a null-guarded lookup keeps painting. `js/transcription-progress.js` turns
  a worker's window and stage messages into a percentage that never falls.
- **Idle retirement.** WASM memory never shrinks once grown and a live
  pipeline holds the model's GPU memory, so the worker is terminated after ten
  idle minutes (#550, #552) and the pipeline released after two (#463). The
  model bytes stay in the browser cache.
- **The model store** registers on `window.HyperaudioModelStores` with the
  Cache API name the runtime stores under and a `label(url)` that names each
  model, so Settings ▸ Downloaded models can size and remove them without
  knowing the engine (#615).
- **The service worker's unit test** has a hand-kept list of worker files.
  Add the new worker there as well as to the precache list, or offline use
  breaks while the test passes.

## 5. Wiring it in

- **Script tags** in `index.html`, the converter after
  `js/converters/transcript-words.js` and the client beside the other clients,
  each with `?v=<release>`.
- **The service worker**, `serviceworker.js`: both files, and any worker, in
  `PRECACHE`. The unit test `__TEST__/unit/service-worker.test.mjs` fails when
  something `index.html` loads is missing from the list.
- **Version stamps.** Each new file has the `@version` header above, set to
  the release it ships in, and every file touched (`index.html`,
  `serviceworker.js`, `editor-core.js`, `hyperaudio-save.js`,
  `transcribe-prefs.js`) has its `@version` and `?v=` moved to that release.
- **The README's engine list** under Transcribe, and the Transcribe dialog
  screenshots there if the tab changes the picture.
- **Unique file names.** One native host, the Glider Mac app, copies the
  editor's tree into a flat resources folder, so no two files anywhere in the
  tree may share a basename. `js/converters/acme.js` beside
  `js/hyperaudio-lite-editor-acme.js` is fine. `js/connectors/acme.js` beside
  `js/converters/acme.js` is not.

## 6. Testing it end to end

A Playwright spec mocks the service and drives the dialog. The pattern, from
`__TEST__/e2e/deepgram-word-text.spec.mjs`:

```js
await page.route('https://api.acme.example/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESPONSE) }));
await page.goto('/index.html');
await page.waitForSelector('#hypertranscript [data-m]');
await page.evaluate(() => {
  document.getElementById('transcribe-modal').checked = true;
  document.querySelector('#acme-key').value = 'test-key';
  const media = document.querySelector('#acme-media');
  media.value = 'https://example.com/talk.mp4';
  media.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#acme-submit-btn').click();
});
await expect.poll(() => page.evaluate(() =>
  document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)').length)).toBe(WORDS.length);
```

Worth a test each: the words and labels land, the project appears in Recents
with the media's name, a finish while another project is open goes to Recents
and leaves the screen alone (`__TEST__/e2e/background-completion.spec.mjs`
shows how), and an error leaves the previous transcript untouched. Run the
specs you touched, and the whole suite before a release.

## 7. Native hosts

A native host such as Glider hides the browser engines and drives the same
contract from its own bridge, in the same order, with the result rendered by
the same `jsonToHTML`. A new browser engine therefore needs nothing on the
host's side. The reverse also holds: a host wanting its own engine writes a
converter for its engine's output and follows section 3, with no tab.

Expose a function on `window` only when a host calls it. `parseData`
(Deepgram) and the caption globals `srtToHtml`, `vttToHtml`,
`convertSrtToWebVtt` and `jsonToHtml` exist for that reason and stay.

## Checklist

- [ ] `js/converters/<name>.js`: pure, registers on `window.HyperaudioConverters`, `module.exports` in node, `labelOnChange` if it diarizes
- [ ] fixture in `__TEST__/fixtures/converters/`, test in `__TEST__/unit/converters/`, `npm run test:unit` green
- [ ] `js/hyperaudio-lite-editor-<name>.js`: template, tab radio with `aria-label`, custom element
- [ ] the contract in order: caption mode off, media on the player, `showTranscriptNotice` with `.transcribing-msg`, `setTranscriptBusy(true)`, then background check, `hyperaudioKeepTranscription`, `innerHTML`, `setTranscriptionInfo`, `setTranscriptBusy(false)`, `hyperaudioInit`, `hyperaudioGenerateCaptionsFromTranscript`
- [ ] errors through `showTranscriptNotice`, always `setTranscriptBusy(false)`
- [ ] `info` with `service`, `model`, `language`, `languageCode`, `seconds`, `modelId`, `parameters`, no credentials
- [ ] input ids added in `editor-core.js`, `hyperaudio-save.js` (`wireCapture`), `transcribe-prefs.js` and `transcribe-from-project.js`
- [ ] local engine: worker path with `?v=`, device choice and report, progress into `.transcribing-msg`, idle retirement, `HyperaudioModelStores`, the SW test's worker list
- [ ] script tags with `?v=`, `PRECACHE`, `@version` on every touched file
- [ ] no duplicate basenames in the tree
- [ ] README engine list, an e2e spec with `page.route`

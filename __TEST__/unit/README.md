# Unit test lane (`npm run test:unit`)

Runs `node --test` over `__TEST__/unit/**/*.test.mjs`, subfolders included.
No dependencies, no browser, and the whole lane finishes in well under a
second. It needs Node 21 or later (CI uses 22).

## What is in it

Every module here is a classic script that also exports itself in node, so a
test loads it with `createRequire` and calls it directly. In rough groups:

- **The converters**, `converters/`: one test per source in `js/converters/`
  (Deepgram, AssemblyAI, Parakeet, Whisper, Whisper JSON, SRT and VTT), each
  run against a fixture of that source's real output in
  `../fixtures/converters/`. The fixtures are the same 19-word, two-speaker
  exchange, so the tests read alike. `docs/adding-an-stt-engine.md` says how
  to add one.
- **The transcript**: the paragraph rule, `html-json-converter`, word
  alignment, transcript maintenance, search matching.
- **Captions**: the caption door (checks the vendored `caption.js` is
  byte-identical to upstream), abbreviations, speaker colours, word VTT.
- **Export and provenance**: export names and pins, the document export,
  TPME, stream stretch.
- **Media sources**: audio source, HLS source, the Whisper JSON import.
- **The app itself**: `hyperaudio-save`, the language guess and tag,
  transcription progress, and the service worker, which checks that
  everything `index.html` loads is precached and that the cache version is
  the release's.

## How a module gets here

The lane fills by **modularisation**: when a feature change or refactor earns
its release anyway, extract the pure logic into its own file (DOM reading
stays in a thin wrapper), register it on `window` for the page and on
`module.exports` for node, and add its tests here in the same change. The
converters are the pattern to copy, with `js/converters/transcript-words.js`
the smallest example.

Rule of thumb: never bump a release *only* to make something testable, but
when a module is being touched anyway, leave its logic purer than you found
it and add the unit tests in the same change.

Still on the list:

- **The cut model** (`computePlayableSections`'s arithmetic in
  `editor-audio-cut.js`). The #371/#383 regressions were pure timing logic.
- **Export re-timing** (`mapTime` and the retimed transcript in
  `media-export.js`). The clip cue trimming (#748) is covered end to end
  only.

The Playwright suite in `../e2e/` covers everything that needs a page.

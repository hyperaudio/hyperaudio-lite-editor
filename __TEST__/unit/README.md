# Unit test lane (`npm run test:unit`)

Runs `node --test` against this directory — no dependencies, no browser,
millisecond feedback.

**It is empty by design.** Today every editor module touches the DOM at load
time, so nothing can be imported into Node directly; behaviour is covered by
the Playwright e2e suite in `../e2e/` instead.

## Modularisation: how this lane fills up

The path to unit tests is **modularisation**: when a feature change or refactor
earns its release anyway, extract the pure logic into its own importable module
(DOM reading stays in a thin wrapper) and add its tests here. Candidates, in
rough order of value:

- **The cut model** (`computePlayableSections`'s arithmetic in
  `editor-audio-cut.js`) — the #371/#383 regressions were pure timing logic; a
  pure `computeCutSections(words, duration, opts)` would guard them at unit
  speed.
- **Export re-timing** (`mapTime` / `buildRetimedTranscriptHtml`'s maths in
  `media-export.js`).
- **Search helpers** (`normalise` / `findRawRange` in
  `hyperaudio-lite-extension.js` — ported from upstream, which already
  unit-tests them in its own repo).
- **Caption/format converters** (`html-json-converter.js`).

Rule of thumb: never bump a release *only* to make something testable — but
when a module is being touched anyway, leave its logic purer than you found it
and add the unit tests in the same change.

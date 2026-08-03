# `.hyperaudio` conformance fixtures

Shared test cases for the format specified in [`../hyperaudio-format.md`](../hyperaudio-format.md).
Every implementation (this editor's `js/hyperaudio-save.js`, native apps) runs
these; a container written by one implementation must open losslessly in the
others.

Currently the cases are embodied executable-first in this repo's unit lane
(`__TEST__/unit/hyperaudio-save.test.mjs` — path rules incl. the legal `..`
substring, unknown-field preservation, `kind: "none"`, invalid UTF-8, byte
caps, compressed-media rejection, hostile filename sanitization) and e2e lane
(`__TEST__/e2e/project-save.spec.mjs` — full editor round trip, OPFS restore).

Next step (tracked in hyperaudio-lite-editor#447): generate the cases as
checked-in `.hyperaudio` files with an expectations manifest, so non-JS
implementations consume them without running this repo's test harness. The
planned matrix:

- legal `mix..final.mp3`; `/`, `\`, `.`, `..`, empty and Unicode filenames
- unknown top-level and nested fields (must survive open→save)
- newer minor (loads), newer major (clean rejection), malformed versions
- invalid UTF-8; oversized declared and actual text entries
- compressed media entry (rejection); `link` media; `none` media; missing media
- captions absent / present / intentionally divergent
- `transcript.original.json` byte preservation

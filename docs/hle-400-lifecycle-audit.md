# #400 — Phase 0 lifecycle and mutation audit

This audit records the lifecycle contract implemented before transcript history.
It is intentionally narrower than the Phase 1 gateway audit: Phase 0 identifies
identity boundaries, same-document refresh consumers, and known mutation doors.

## Lifecycle signals

| Signal | Meaning | Identity generation |
|---|---|---:|
| `hyperaudioInit` | legacy notification that transcription/import installed a document | does not itself increment the public lifecycle counter |
| `hyperaudioDocumentIdentityChanged` | a valid different document committed to the save session | increments once |
| `hyperaudioTranscriptLoaded` | legacy project-apply refresh | unchanged; not an identity contract |
| `hyperaudioTranscriptRestored` | undo/redo/version replaced DOM within the same document | unchanged |

`hyperaudioInit` remains identity-only in existing production call sites, but
history will baseline on `hyperaudioDocumentIdentityChanged`. This avoids timing
ambiguity: the save listener commits session identity during/after init, while
project-file and Recents loads do not dispatch init at all.

Signals are accepted only while the live transcript contains `span[data-m]`, so
loader/error markup cannot create or restore an identity.

## Identity commit inventory

| Path | Internal commit | Public origin |
|---|---|---|
| transcription, JSON import, SRT/VTT import | `onNewTranscript()` increments `identityGeneration` | `transcription-or-import` |
| opening a portable `.hyperaudio` file | `openFromFile()` hydrates a new session and increments | `project-file-open` |
| boot restore or switching Recents project | `applyProjectFiles()` increments | `project-library-open` |

Deleting and re-homing the current Recents entry does not change the on-screen
document and therefore does not emit a document identity signal.

## Same-document restore consumers

| Consumer | Restore action |
|---|---|
| `editor-audio-cut.js` | rebuild strike/gap data and refresh Hyperaudio word indexes |
| `paragraph-timecodes.js` | rebind to the current transcript and reposition labels |
| `find-replace.js` | discard stale `mark` element references and reset match UI |
| save/autosave | no identity action; Phase 2 will send one synthetic `input` for dirty state |

`hyperaudioInit` is deliberately not dispatched by the restore API.

## Known document mutation inventory for Phase 1

| Mutation family | Current mechanism | Required classification |
|---|---|---|
| native typing/delete/cut/paste | browser `beforeinput`/`input` | native edit window |
| debounced sanitise | module-local DOM rewrite | gateway |
| blur normalization | direct `normalizeTranscriptSpans()` call | gateway |
| Replace / Replace All | programmatic mark replacement | gateway |
| strike/unstrike | programmatic inline-style mutation, no `input` | gateway |
| search highlighting | programmatic `<mark>` wrapping | view-state exemption |
| show/hide speakers | inline `display` mutation | view-state exemption |
| transcription/import result | wholesale `innerHTML`/children replacement | identity-loading window |
| project open/Recents restore | wholesale children replacement | identity-loading window |
| alignment result | wholesale transcript replacement followed by init | identity-loading window |
| caption-mode round trip | clone/detach/reinsert transcript | view/lifecycle operation, same identity |

Phase 1 must add the scoped mutation-bypass diagnostic once gateway and native
edit-window flags exist; adding it in Phase 0 would report unavoidable false
positives because those classifications do not yet have runtime markers.

## Phase 0 invariants

1. Identity generations are monotonic and advance only for a valid timed
   document.
2. Restore events retain the current generation.
3. Restore never creates a save session, changes project id, or calls init.
4. DOM-replacement consumers do not retain stale transcript/search references.

## Known edge for Phase 2 (review finding)

The `span[data-m]` guard sits on the identity *emitter*: opening a document
whose transcript is empty/untimed drops the identity signal, so a history stack
from the previous document would survive. Residual risk is narrow — undo is
disabled without a timed transcript, and every path that later installs timed
spans emits its own identity signal — but conceptually the guard belongs on
*restore* (never restore into an invalid state), while identity changes are
real regardless of DOM validity. Phase 2 must either move the guard to
`signalRestored` only, or additionally reset history on `hyperaudioInit` as a
belt-and-braces.
5. Loader/error markup emits neither identity nor restore signals.

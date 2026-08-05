# #400 — Revised intervention plan: isolated snapshot undo/redo

**Status:** implementation-ready revision of the engineering plan for #400.
It preserves the accepted architecture — the live transcript DOM is the source
of truth, history stores snapshots, and programmatic document mutations cross a
gateway — while aligning the design with the current lifecycle on `main`
(`v1.1.7` plus subsequent fixes; line numbers must be rechecked when coding).

This revision deliberately separates:

- **document identity**: a transcript was imported, transcribed, opened, or
  otherwise replaced by a different document;
- **document mutation**: the current transcript changed and remains the same
  document;
- **DOM restoration**: history replaced the DOM with an older/newer state of
  that same document;
- **view state**: search marks, active-word highlighting, speaker visibility,
  focus, scroll, and other presentation details.

That distinction is the main safety invariant. In particular, undo/redo must
never look like a new project to OPFS/autosave.

---

## 1. Governing constraints

1. The live `#hypertranscript` DOM remains the editing source of truth.
2. Undo/redo uses bounded snapshots, not inverse commands.
3. Every **programmatic document mutation** crosses one mutation gateway.
4. Native user edits are observed at `beforeinput`/`input`; they do not need to
   be reimplemented through the gateway.
5. `hyperaudioInit` means **new document identity only**. History restore must
   never dispatch it.
6. History snapshots contain document state, not transient view state.
7. New logic remains in self-contained IIFEs where practical, but isolation is
   subordinate to correctness. Existing-file changes are small and audited,
   rather than capped at an artificial number.
8. Each phase is independently testable and lands behind `undoStack` until the
   feature is ready to enable by default.

---

## 2. Lifecycle contract

Before implementing the stack, formalise the events used by the editor.

### `hyperaudioInit`

Meaning: a different document has become current.

Existing consumers may:

- rebuild the Hyperaudio instance;
- create/reset the save-session identity;
- increment `identityGeneration`;
- reset caption caches;
- initialise a new history baseline.

Sources include transcription completion and JSON/SRT/VTT import. History
listens to this event and calls `reset()` only when a valid timed transcript is
present.

### `hyperaudioTranscriptRestored` (new)

Meaning: the DOM of the **same document** was replaced by undo/redo or a future
same-document restore operation.

The event carries non-persistent detail:

```js
new CustomEvent('hyperaudioTranscriptRestored', {
  detail: { origin: 'undo' | 'redo' | 'version' }
})
```

Consumers may:

- rebuild the player's word index and visual state;
- rebuild strike/gap data and paragraph timecodes;
- invalidate stale find/replace element references;
- update controls derived from the transcript.

Consumers must not:

- create a project;
- increment `identityGeneration`;
- reset history;
- discard the current save envelope;
- treat the operation as an import or transcription.

### Synthetic `input`

After a history restore, dispatch one bubbling synthetic `input` from the
current `#hypertranscript`. It is the existing dirty/autosave signal. History
ignores that event while `gateway.isRestoring` is true, while the delegated save
listener still sees it.

The restore event handles structural refresh; `input` handles dirty state. The
two responsibilities remain separate.

---

## 3. State model

### Document state stored in history

- paragraph/section/article structure;
- word text;
- `data-m` and `data-d` timing;
- semantic speaker spans/classes;
- strike state;
- other attributes proven to affect saved/exported transcript meaning.

### View/runtime state excluded from history

- `mark.search-mark` and `.active`;
- current karaoke/word highlighting;
- speaker visibility (`style.display` driven by `#show-speakers`);
- paragraph timecode UI outside the contenteditable;
- focus and scroll position, except selection/caret stored separately;
- runtime-only attributes/classes already identified by the serializer.

Do not strip `style` generically: strike is currently represented by
`text-decoration: line-through`, while speaker visibility also uses inline
style. The snapshot cleaner must distinguish the two.

### Snapshot shape

```js
{
  html,                 // cleaned raw-ish innerHTML, suitable for restoration
  semanticFingerprint, // structure/text/timing/strike/speaker fingerprint
  selection,            // anchor/focus offsets and direction
  origin,
  timestamp
}
```

Raw-ish HTML is used because canonical indentation changes character offsets.
Durable versions use the canonical serializer instead.

`semanticFingerprint` must cover semantic HTML/timing, not merely
`textContent`. Equal text can still contain different timing, paragraph,
speaker, or strike state.

---

## 4. New modules

### `js/transcript-gateway.js`

```js
window.transcriptGateway = {
  mutate(fn, { origin, foldPolicy } = {}),
  get isRestoring(),
  onBeforeMutate(callback),
  onAfterMutate(callback)
};
```

Responsibilities:

- provide one transaction boundary for programmatic document mutations;
- support nested mutations as one outer transaction;
- expose before/after notifications to history;
- suppress history capture during restore;
- always clear internal flags with `try/finally`;
- return the callback's result and rethrow its errors.

It holds no undo stack and does not decide whether a mutation is meaningful.

### `js/transcript-history.js`

```js
window.transcriptHistory = {
  undo({ focus } = {}),
  redo({ focus } = {}),
  canUndo(),
  canRedo(),
  reset(),
  flushPending()
};
```

Responsibilities:

- baseline, undo, and redo entries;
- native-edit observation and typing coalescing;
- gateway transaction capture;
- selection capture/restore;
- history keyboard/menu interception;
- identity reset;
- same-document restore;
- depth/memory pruning;
- Undo/Redo control state and touch UI.

All transcript event listeners are delegated from `document` (normally capture
phase) because caption mode clones and replaces `#hypertranscript`.

### `js/transcript-clipboard.js`

Adds validated timing-aware clipboard exchange after plain cut/paste history is
stable.

### `js/transcript-versions.js`

Adds durable named canonical snapshots only after a format/storage specification
is agreed. It is not required to close #400.

---

## 5. Mutation inventory and gateway coverage

The implementation begins with a code audit and a test-backed inventory. At
minimum the current gateway must cover:

1. `sanitise()` document changes: orphan merging, speaker extraction, and its
   normalization call;
2. `normalizeTranscriptSpans()` when invoked directly from `blur` as well as
   from the debounced sanitiser;
3. find Replace and Replace All;
4. strike-through commands, which currently mutate styles without emitting
   `input`;
5. any speaker-changing command that changes transcript semantics.

The show/hide-speakers preference is view state and does not cross the gateway.
Search highlighting is also view state.

Transcription results, imports, project open, and alignment that installs a new
transcript are identity changes, not undoable mutations of the old document.
Their loading/error DOM is ignored, and their final valid transcript establishes
a new baseline through the identity lifecycle.

During development, attach a scoped `MutationObserver` diagnostic that records
mutations to the live transcript occurring outside:

- an active gateway transaction;
- a native `beforeinput` → `input` edit window;
- a history restore;
- an explicit identity-loading window;
- known view-state operations.

The observer is an assertion/safety net, not the production history mechanism.
The feature cannot be enabled by default while unexplained bypasses remain.

---

## 6. Native editing and coalescing

### Before/after capture

For native edits, `beforeinput` captures the pre-edit state when a new group is
about to begin. `input` captures the resulting current state. Relying on
`input` alone cannot reconstruct the pre-edit DOM.

Group contiguous typing/deleting when all are true:

- compatible `inputType` category;
- same document identity;
- selection continuity is plausible;
- no forced boundary intervened;
- elapsed time is below the chosen window (initially 500 ms).

Forced boundaries include:

- paste and cut;
- paragraph/structural edits;
- gateway mutations;
- strike/speaker changes;
- find-replace;
- blur;
- undo/redo;
- identity change;
- IME composition completion.

IME handling:

- never restore or normalize during composition;
- ignore undo shortcuts with `event.isComposing`;
- treat the whole composition as one edit, committed at `compositionend` and
  its associated final input;
- test Safari/WebKit composition ordering explicitly.

---

## 7. Owning Undo/Redo

### Primary interception

Use delegated `beforeinput` and intercept:

- `historyUndo`;
- `historyRedo`.

Call `preventDefault()` before invoking history. This route covers browser UI
that emits history input events, including context/menu actions where supported.

### Keyboard fallback without double execution

`keydown` for Cmd/Ctrl+Z is secondary. Because it normally precedes
`beforeinput`, it must not execute undo immediately and then allow the later
history event to execute it again.

Use a small fallback protocol:

1. on matching `keydown`, prevent native handling and schedule one fallback
   action for the next task;
2. if the corresponding `beforeinput` arrives, cancel the scheduled action and
   execute exactly once there;
3. otherwise run the scheduled fallback;
4. clear the token on keyup/blur and after execution.

Validate the precise scheduling on Chromium, Firefox, and WebKit. If preventing
keydown suppresses `beforeinput` on a target browser, use capability/browser
behaviour detection established by tests rather than assuming one universal
ordering.

Shortcuts are ignored when:

- `event.isComposing` is true;
- focus is in another editable/input/textarea that is not the transcript;
- caption mode is active;
- no valid live timed transcript exists.

On macOS support Cmd+Z and Cmd+Shift+Z. On platforms that conventionally expose
Ctrl+Y for redo, support it in addition to Ctrl+Shift+Z.

---

## 8. Selection model

Store both selection endpoints relative to transcript text:

```js
{
  anchor: absoluteCharacterOffset,
  focus: absoluteCharacterOffset,
  backward: boolean
}
```

Character walking uses text content after view-only marks have been unwrapped,
so mark removal does not alter offsets. Restore with
`Selection.setBaseAndExtent()` where supported; fall back to a Range while
accepting loss of direction only on unsupported engines.

Clamp offsets safely when content differs. If no selection belongs to the
transcript, store `null`.

For toolbar Undo/Redo, focus the current transcript before restoring selection.
For keyboard/menu operations, avoid gratuitous focus changes.

---

## 9. Restore transaction

Undo/redo performs this sequence inside a `try/finally` restore guard:

1. flush/cancel pending coalescing timers;
2. confirm transcript mode and a valid current transcript;
3. set `gateway.isRestoring` through an internal gateway restore helper;
4. replace current `#hypertranscript.innerHTML` with the cleaned snapshot;
5. restore selection as appropriate;
6. dispatch one bubbling synthetic `input` to mark the project dirty;
7. dispatch `hyperaudioTranscriptRestored` with `undo` or `redo` origin;
8. clear the restore guard;
9. update Undo/Redo controls.

Never dispatch `hyperaudioInit` here.

Consumers of `hyperaudioTranscriptRestored` re-index existing subsystems without
creating a new document. Find/replace clears its cached `matches` array and
active UI because restored HTML invalidates element references; it does not
automatically rerun or persist search highlighting.

### Post-restore normalization

Do not fold mutations merely because `textContent` is unchanged.

Normalization carries an explicit origin/fold policy. A normalization scheduled
by the restored DOM may amend the just-restored current entry only when its
semantic policy allows that transformation. It must not:

- create an extra user-visible undo step;
- clear redo;
- absorb timing, strike, speaker, or paragraph changes that are not part of the
  declared normalization;
- run while IME composition or restore is active.

Prefer cancelling stale pre-restore sanitise timers and scheduling one fresh
normalization transaction after restore. Add the minimum editor-core hook needed
to make this deterministic instead of relying on a one-second race.

---

## 10. Caption mode and replaced DOM nodes

Caption mode is inferred through the view switch/current DOM, but listeners do
not bind permanently to a particular transcript element.

- History input/beforeinput listeners are delegated.
- Snapshot/restore always resolves the current element afresh.
- History entries never retain element references.
- Undo/redo is disabled while captions are active.
- Returning to transcript mode must not reset history; it exposes the same
  document node cloned at mode entry.
- A genuine import/transcription performed while caption mode is active still
  produces an identity reset when the new transcript becomes current.

Add a transcript → captions → transcript → edit → undo regression test to prove
that listeners survive the replacement.

---

## 11. Touch and accessible controls

Inject Undo and Redo buttons into the appropriate existing toolbar after its
container exists. Requirements:

- native `<button>` elements;
- visible labels or icons with accessible names;
- disabled state mirrors `canUndo()`/`canRedo()`;
- no operation in caption mode;
- focus is not lost after activation;
- touch targets meet the existing mobile sizing conventions;
- controls survive responsive layout changes without duplication.

Injection avoids permanent markup when cleanly possible; a small markup slot is
acceptable if it improves layout and accessibility.

---

## 12. Clipboard phase

Plain native cut/paste becomes undoable through the Phase 2 native-edit path.
Timing preservation is separate work.

On copy/cut, offer:

- `text/plain` always;
- sanitized `text/html` when supported;
- a versioned custom MIME payload as an optional enhancement, not the only
  interoperable representation.

The timed payload contains only allowlisted transcript structure and timing. On
paste:

1. validate type/version, structure, size, `data-m`, and `data-d`;
2. reject scripts, event attributes, arbitrary styles/classes, and unexpected
   elements;
3. insert the timed fragment in one gateway transaction;
4. otherwise use the safe plain-text path;
5. create exactly one undo step.

Decide with the maintainer whether to replace the current `execCommand` paste
path. Do not insert arbitrary clipboard HTML directly.

---

## 13. Durable versions phase

Treat versions as a separate specification/issue. Do not generically preserve
all unknown ZIP entries.

Define an allowlisted `versions/` namespace with:

- manifest/version schema;
- safe path grammar and duplicate-name behaviour;
- maximum version count;
- per-entry and aggregate byte limits;
- canonical transcript representation;
- timestamps/names/identifiers;
- pruning policy;
- behaviour on malformed entries;
- OPFS working-copy relationship;
- restore semantics: one undoable same-document transaction or explicit
  history reset.

`zipProject()` currently rebuilds a fixed entry list, so writer and reader must
both gain explicit `versions/` handling. Security tests cover path traversal,
zip bombs, oversized entries, invalid UTF-8, and unrecognised formats.

Version restore must use the same-document restore lifecycle and must not emit
`hyperaudioInit` unless the product intentionally defines opening a version as a
new document.

---

## 14. Phased implementation

### Phase 0 — lifecycle and mutation audit

- [ ] Introduce/document `hyperaudioTranscriptRestored`.
- [ ] Add non-identity refresh listeners for player/strike/gaps/timecodes.
- [ ] Add find/replace cache invalidation on restore.
- [ ] Inventory all live transcript mutation sites.
- [ ] Add a diagnostic bypass observer/test.
- [ ] Confirm `hyperaudioInit` remains identity-only.

No undo UI or behavioural change yet.

### Phase 1 — gateway

- [ ] Add `transcript-gateway.js` with nesting and `try/finally` safety.
- [ ] Route sanitise and direct blur normalization through it.
- [ ] Route Replace and Replace All through it.
- [ ] Capture strike and semantic speaker changes.
- [ ] Explicitly exempt search and speaker visibility view state.
- [ ] Load gateway before any wrapped mutator.
- [ ] With flag off, prove DOM/output behaviour is unchanged.

### Phase 2 — history and #400 closure

- [ ] Add cleaned raw snapshot and semantic fingerprint helpers.
- [ ] Add baseline, undo/redo stacks, pruning, and public API.
- [ ] Capture native before/after states with coalescing.
- [ ] Add IME-safe composition handling.
- [ ] Add anchor/focus selection preservation.
- [ ] Add delegated `beforeinput` ownership.
- [ ] Add tested, single-execution keyboard fallback.
- [ ] Reset only on valid identity events.
- [ ] Restore using `input` + `hyperaudioTranscriptRestored`, never init.
- [ ] Make post-restore normalization deterministic.
- [ ] Add caption-mode no-op and DOM-replacement resilience.
- [ ] Add accessible touch Undo/Redo controls.

### Phase 3 — timed clipboard

- [ ] Add safe copy/cut representations.
- [ ] Validate and insert timed payload atomically.
- [ ] Preserve safe plain-text fallback.
- [ ] Decide and document `execCommand` retirement.

### Phase 4 — versions specification and implementation

- [ ] Approve schema, bounds, storage, and restore semantics.
- [ ] Implement explicit container reader/writer support.
- [ ] Add version UI and lifecycle integration.

### Phase 5 — enable and cleanup

- [ ] Resolve every mutation-observer bypass.
- [ ] Enable `undoStack` by default.
- [ ] Remove temporary diagnostics or retain a development assertion.
- [ ] Add WebKit to Playwright CI and complete manual Safari/mobile passes.

---

## 15. Required tests

### History correctness

- typing/delete coalescing and forced boundaries;
- cross-word and cross-paragraph undo/redo;
- timing changes from split/merge normalization;
- redo after post-undo normalization;
- Replace and Replace All as one step each;
- strike undo/redo and downstream audio cuts;
- speaker extraction/change without capturing visibility preference;
- new import/transcription cannot undo into the previous document;
- undo does not change project id or `identityGeneration`;
- undo does not trigger project birth or clear the save envelope;
- memory/depth pruning on large transcripts.

### Input and selection

- forward and backward selections;
- collapsed caret at start/end and around speaker spans;
- IME composition;
- autocorrect and dictation where automatable;
- cut, paste, drag/drop, and mobile virtual keyboard;
- Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, and Ctrl+Y;
- exactly one action when both keydown and beforeinput occur;
- context/menu `beforeinput` where browser automation permits.

### Lifecycle and UI

- transcript → captions → transcript → edit → undo;
- caption-mode commands are no-ops;
- restored DOM refreshes player, strikes, gap calculations, and timecodes;
- active search is safely invalidated after restore;
- touch buttons, disabled state, focus, accessible names, and no duplication;
- autosave becomes dirty after restore but document identity is unchanged.

### Clipboard and versions

- timed cut/copy/paste round-trip;
- plain paste produces safe untimed content;
- hostile clipboard HTML is rejected/sanitized;
- version entries survive re-save within declared limits;
- malformed/oversized/path-traversal ZIP entries are rejected.

Run existing serialization, DOM hygiene, search, captions, audio-cut, export,
project-save, and library suites as regressions.

---

## 16. Revised isolation scorecard

| Existing area | Expected touch | Reason |
|---|---:|---|
| `index.html` | script tags, optional toolbar slot | load modules / accessible placement |
| `editor-core.js` | small gateway hooks + deterministic refresh/normalization hook | sanitise and blur normalization are module-local |
| `find-replace.js` | gateway transaction + restore cache invalidation | semantic replace and stale node references |
| strike command owner | small gateway/event hook | strike emits no native input |
| player/gap/timecode consumers | restore-event listener where needed | refresh same document without init |
| `hyperaudio-save.js` | no Phase 2 identity change; Phase 4 explicit versions support | undo must not create projects |
| transcription/import engines | normally no change | existing init remains identity boundary |

The exact file count follows the mutation audit. Acceptance is based on no
unexplained gateway bypasses and no identity side effects, not on preserving an
arbitrary two-wrap limit.

---

## 17. Decisions to confirm before coding

1. Initial history depth and aggregate memory budget; proposed starting point:
   100 entries plus a conservative byte cap, pruning oldest entries while
   retaining the current baseline.
2. Exact semantic snapshot cleaner allowlist.
3. Whether strike should be moved into the gateway directly or exposed through
   a small command event/API.
4. Browser-tested keydown fallback protocol.
5. Clipboard scope: enriched copy only versus full timed paste.
6. Version schema/storage/restore semantics in a separate issue.

None of these decisions changes the lifecycle rule: history restoration remains
a mutation of the same document and never emits `hyperaudioInit`.

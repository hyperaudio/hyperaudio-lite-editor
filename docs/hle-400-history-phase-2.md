# #400 — Phase 2 snapshot history

Phase 2 installs `window.transcriptHistory` and enables transcript undo/redo.
The live DOM remains the source of truth; history keeps at most 100 cleaned
snapshots under a 12 MiB aggregate budget.

## Snapshot and folding invariants

Each entry contains cleaned restorable HTML, selection endpoints, and a semantic
fingerprint. The fingerprint encodes article/section/paragraph structure plus
word text, timing, speaker, and strike state. Search marks, active playback
state, and speaker visibility are excluded.

An explicit `normalization` gateway transaction may amend the current entry
only when its pre-mutation fingerprint exactly equals that entry. This is the
guard that lets post-restore normalization preserve redo while preventing a
stale normalization pass from folding across a semantic edit.

## Native edits and shortcuts

Delegated `beforeinput` captures the pre-edit state and `input` captures the
result. Compatible typing/deletion is coalesced for 500 ms when selection and
identity continuity hold. Paste, cut, structural input, blur, gateway commands,
identity changes, and composition completion force boundaries.

`beforeinput` owns `historyUndo`/`historyRedo`. Cmd/Ctrl+Z keydown installs a
next-task fallback: a matching history `beforeinput` cancels it and executes the
action; if no such event arrives, the fallback executes once. Keyup/window blur
flush a still-pending fallback. The protocol suite passes on Chromium, Firefox,
and WebKit, including a real platform shortcut test.

IME composition stores one pre-composition snapshot and commits once whether
the final `input` arrives before or after `compositionend`.

## Restore and identity

Restore runs inside `transcriptGateway.restoring`, replaces only the current
transcript HTML, restores anchor/focus direction, emits one synthetic `input`,
and signals `hyperaudioTranscriptRestored`. It never emits `hyperaudioInit` or
advances identity generation. Editor core cancels stale sanitise work and runs
one deterministic foldable normalization after restore.

Identity emission is now unconditional. An empty, untimed, loader, or error DOM
therefore clears old history; only a valid timed transcript creates the new
baseline. This resolves the Phase 0 review finding.

## UI and caption mode

Accessible native Undo/Redo buttons are injected once beside the editing tools.
They mirror stack state, support touch sizing through the existing button
classes, restore focus when activated, and are disabled/no-op in caption mode.
All document listeners are delegated, so the transcript/caption clone-and-
replace round trip does not strand history on an obsolete DOM node.

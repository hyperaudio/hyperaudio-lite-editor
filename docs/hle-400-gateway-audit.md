# #400 — Phase 1 gateway audit

Phase 1 adds the transaction boundary used by snapshot history without yet
installing a history subscriber. Wrapping is therefore behaviour-neutral: the
same synchronous mutators run and return as before.

## Gateway contract

`window.transcriptGateway` provides:

- `mutate(fn, { origin, foldPolicy })`;
- `onBeforeMutate(callback)` / `onAfterMutate(callback)`, each returning an
  unsubscribe function;
- nested mutations collapsed into the outer transaction;
- `isMutating`, `currentTransaction`, and a nest-safe `restoring(fn)` guard;
- `try/finally` cleanup and after notification when a mutator throws;
- an opt-in MutationObserver audit for tests/development.

Subscriber errors are logged and isolated so a future history defect cannot
prevent an editor command from running.

## Routed document mutations

| Origin | Owner | Scope |
|---|---|---|
| `normalize-blur` | `editor-core.js` | direct blur span normalization |
| `sanitise` | `editor-core.js` | debounced normalization, orphan merging, speaker extraction |
| `replace-one` | `find-replace.js` | one semantic text replacement |
| `replace-all` | `find-replace.js` | all replacements as one transaction |
| `strike` | `editor-audio-cut.js` | strike/unstrike plus derived audio refresh |

The gateway script loads before every routed mutator. Each call retains a
fallback direct invocation for partial/legacy embedding where the gateway
script is absent.

## Explicit non-document classifications

- search highlighting: `mark.search-mark`, `.search-match`, and their text-node
  wrapping/unwrapping are view state;
- speaker `display` style changes are view state;
- speaker `text-decoration` is not exempt because it can encode strike state;
- native edits are claimed between delegated `beforeinput` and `input`;
- history restore mutations are claimed by `restoring(fn)`.

## Diagnostic audit

The observer is off by default. Tests call:

```js
transcriptGateway.audit.start(transcript);
// exercise one operation
const violations = transcriptGateway.audit.violations();
transcriptGateway.audit.stop();
```

Gateway and native records are synchronously claimed with
`MutationObserver.takeRecords()` before their transaction window closes. Any
remaining semantic record is `unclassified` and therefore a bypass candidate.

Identity-loading mutations are not classified by this observer in Phase 1:
the audit is scoped to a stable live transcript, and identity paths are covered
by the Phase 0 lifecycle audit/tests.

## Deferred to Phase 2

Claude's Phase 0 review finding remains open: identity must advance/reset
history even when the new document is empty or untimed. Phase 2 must move the
timed-transcript validity guard from identity emission to restore eligibility
(or install an equivalent unconditional reset signal). It is not a gateway
concern and P1 does not change the current lifecycle contract.

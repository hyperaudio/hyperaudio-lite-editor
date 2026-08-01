# The `.hyperaudio` file format

**Version 1.2** · Status: **frozen for cross-implementation interchange**

This document is the normative specification. It originated as the v1.1 spec
in [hyperaudio-lite-editor#403](https://github.com/hyperaudio/hyperaudio-lite-editor/issues/403);
this file supersedes that comment. Shared conformance fixtures live in
[`docs/format-fixtures/`](format-fixtures/) — every implementation runs them.

| Version | Changes |
|---|---|
| 1.0 | Initial format |
| 1.1 | `media.kind: "link"` — declared remote media with reconciliation (§ 7.2.1, § 7.3) |
| 1.2 | `media.kind: "none"` (§ 7.2.2); writer-side unknown-field preservation made normative (§ 8.1); STORE required for media entries on read (§ 7.1); `media.path` segment rule and byte-measured caps pinned (§ 10.2, § 10.3); container exclusion of app/session identity made explicit (§ 9) |

---

> **To the reader (human or LLM):** this document specifies a file format. Rules
> marked **MUST** / **MUST NOT** are binding for writers and readers; **SHOULD**
> is a strong recommendation; **MAY** is optional behaviour.

---

## 1. What a `.hyperaudio` file is

A `.hyperaudio` file is the **working save** of a Hyperaudio Lite Editor
project: media + word-synchronized transcript + captions + project settings,
in a single portable file.

Technically it is a **renamed ZIP archive** (like `.epub`, `.docx`, `.sketch`),
designed to be read and written by:

- Hyperaudio Lite Editor (in the browser)
- future native apps (desktop / mobile)
- any tool that can open a zip and parse JSON

### 1.1 SAVE, not EXPORT — the founding principle

A `.hyperaudio` file captures the **state of the work**; it does not produce a
finished result. Three rules follow:

1. The container **MUST NOT** contain derived or rendered artifacts: no
   edited/cut media, no captions burned into frames, no re-timed transcript,
   no word-level karaoke VTT. Those are what the editor's *export* functions
   are for.
2. The media inside the container is the **original, byte for byte**. Saving
   never re-encodes anything.
3. Everything that is **non-reconstructible working state** goes in: the text
   with in-progress redactions, the current captions (which may have been
   hand-edited), the original machine transcription, the project settings.

In short: a `.hyperaudio` is a **working zip** that preserves the edits in
full — editing is *non-destructive*: decisions (redacted words, silences to
skip) travel **as data** (`struck`, options) on top of the intact original
media, and are applied at playback and at export time. Only *rendered* export
products stay out.

> **Privacy consequence — share exports, not project files.** Because the
> container preserves the work in full, it includes the *complete original
> media* and every redacted word as recoverable data. A `.hyperaudio` given to
> someone else discloses exactly what its editor struck out. When redactions
> or cuts matter, share a *rendered export* (or a flattened new project whose
> media is the rendered result); treat the project file itself like a source
> document.

### 1.2 Format identity

| Property | Value |
|---|---|
| Extension | `.hyperaudio` |
| MIME type | `application/vnd.hyperaudio+zip` |
| Container | ZIP (standard PKZIP) |
| Text encoding | UTF-8, always |
| Current version | `1.1` |

---

## 2. Container structure

```
project.hyperaudio  (ZIP)
├── mimetype                   ← first entry, NOT compressed (see 2.1)
├── hyperaudio.json            ← THE file: version + media + options + texts + transcript (§ 3)
├── transcript.html            ← the transcript in the editor's native format, for compatibility (§ 4)
├── transcript.original.json   ← optional: the original machine transcription, immutable (§ 5)
├── captions.vtt               ← the current captions, WebVTT (§ 6)
└── media/
    └── <original filename>    ← the original media, STORE entry (§ 7)
```

Rules:

- `hyperaudio.json` **MUST** be present. It is the single source of truth for
  the working state.
- `transcript.html` and `captions.vtt` **SHOULD** be present (a conforming
  writer always writes them; a reader must tolerate their absence).
- `transcript.original.json` is **optional**: present only when the project
  was born from an automatic transcription (or from an import whose origin
  was kept).
- `media/` contains **at most one file**. It may be absent when `media.kind`
  is `"link"` (§ 7.2.1).
- Readers **MUST** ignore unknown files in the container (this allows
  non-breaking future additions).

### 2.1 The `mimetype` entry (EPUB/ODF convention)

The first entry of the zip is a file named `mimetype`, containing exactly the
string:

```
application/vnd.hyperaudio+zip
```

with no trailing newline, **stored without compression** (STORE method) and
with no extra fields. This puts the MIME type bytes at a **fixed offset of
38** in the physical file: a native app can recognise a `.hyperaudio` by
reading the first ~80 bytes, without even opening the zip.

- Writers **MUST** write this entry first, uncompressed.
- Readers **SHOULD** verify it, but **MUST** tolerate its absence (files
  produced by generic tools that re-zip the content remain valid).

---

## 3. `hyperaudio.json` — field-by-field reference

One `JSON.parse` and you have the whole project except the media. A complete,
valid example is in the collapsed section at the end of this comment.

### 3.1 Root

| Field | Type | Required | Description |
|---|---|---|---|
| `format` | string | ✔ | Always `"hyperaudio"`. Sanity check for readers. |
| `formatVersion` | string | ✔ | `"major.minor"`, e.g. `"1.0"`. Rules in § 8. |
| `generator` | object | ✔ | Who wrote the file: `{ "name": string, "version": string }`. Diagnostic only. |
| `created` | string | ✔ | ISO 8601 UTC — when the project was first created. |
| `modified` | string | ✔ | ISO 8601 UTC — last save. |
| `media` | object | ✔ | Media descriptor (§ 3.2). |
| `options` | object | ✔ | Project settings (§ 3.3). |
| `texts` | object | ✔ | Key textual metadata (§ 3.4). |
| `provenance` | object | – | Origin of the transcription (§ 3.5). |
| `transcript` | object | ✔ | The complete working transcript (§ 3.6). |

### 3.2 `media`

```json
"media": {
  "kind": "original",
  "path": "media/intervista-maria.mp4",
  "url": null,
  "filename": "intervista-maria.mp4",
  "mimeType": "video/mp4",
  "durationSeconds": 62.5,
  "sizeBytes": 48211337
}
```

| Field | Type | Description |
|---|---|---|
| `kind` | string enum | The media "formula": `"original"` (1.0), `"link"` (1.1, § 7.2.1) or `"none"` (1.2, § 7.2.2). Reserved value: `"audio-m4a"` (§ 7.2). Behaviour on an unknown `kind`: § 7.3. |
| `path` | string \| null | Path inside the zip (with `kind: "original"` / `"audio-m4a"`). `null` with `"link"`. Security constraints in § 10. |
| `url` | string \| null | URL of the media on the web (only with `kind: "link"`). Otherwise `null`. |
| `filename` | string | The original filename chosen by the user, preserved. |
| `mimeType` | string | MIME type of the media (`video/mp4`, `audio/mpeg`, …). |
| `durationSeconds` | number | Duration in seconds (float). Informational; also used for reconciliation (§ 7.3). |
| `sizeBytes` | number | Size of the media file in bytes. Informational; also used for reconciliation (§ 7.3). |

### 3.3 `options` — project settings

```json
"options": {
  "gapRemoval": { "enabled": true, "thresholdMs": 500, "bufferMs": 100 },
  "captions": { "updateFromTranscript": false },
  "view": { "showSpeakers": true, "showTimecodes": false }
}
```

| Field | Type | Description |
|---|---|---|
| `gapRemoval.enabled` | bool | Silence skipping active in preview. |
| `gapRemoval.thresholdMs` | int | Minimum pause (ms) for a silence to be skipped. |
| `gapRemoval.bufferMs` | int | Margin (ms) kept at the edges of a skipped silence. |
| `captions.updateFromTranscript` | bool | **The flag that governs divergence** (§ 6.1). `true` = captions are derived; the editor regenerates them on every transcript edit. `false` = captions are hand-curated: the editor **MUST NOT** overwrite them. |
| `view.*` | bool | Project display preferences. |

Readers **MUST** ignore unknown keys inside `options`; writers may add keys
with a minor version bump.

⚠️ **`options` MUST NOT ever contain**: API keys, tokens, application
preferences (preferred transcription engine, etc.). Those are *app*
preferences, not project settings — a `.hyperaudio` file gets shared; a key
inside it is a guaranteed leak.

### 3.4 `texts` — key metadata

```json
"texts": {
  "title": "Intervista con Maria — formato di salvataggio",
  "language": "it",
  "summary": "Maria e Piero presentano il nuovo formato .hyperaudio.",
  "topics": ["hyperaudio", "formato file", "salvataggio"]
}
```

Clean data (strings and arrays, never HTML). `title` is also the basis of the
filename suggested at download. `language` is BCP-47 (`"it"`, `"en-GB"`).
`summary` and `topics` may come from the transcription engine or from the
user; they may be an empty string / empty array.

### 3.5 `provenance` (optional)

```json
"provenance": {
  "engine": "deepgram",
  "model": "nova-3",
  "transcribedAt": "2026-07-10T08:55:00Z",
  "originalTranscript": "transcript.original.json"
}
```

| Field | Type | Description |
|---|---|---|
| `engine` | string | Engine that produced the transcription (`deepgram`, `whisper`, `parakeet-local`, …). |
| `model` | string | Model used, if known. |
| `transcribedAt` | string | ISO 8601 UTC of the original transcription. |
| `originalTranscript` | string | Path of the file holding the original machine transcription (§ 5), if kept. |

Records who/what produced the original transcription. Zero cost today,
valuable tomorrow (e.g. deciding whether to re-transcribe with a better
model). Absent when the transcript was pasted/imported without keeping the
origin.

### 3.6 `transcript` — the working transcript

```json
"transcript": {
  "words": [
    { "start": 0.32, "end": 0.84, "text": "Benvenuti" },
    { "start": 0.84, "end": 1.02, "text": "ehm", "struck": true }
  ],
  "paragraphs": [
    { "speaker": "Maria", "start": 0.32, "end": 6.5 }
  ]
}
```

**`words[]`** — every word, in temporal order:

| Field | Type | Description |
|---|---|---|
| `start` | number | Start in **seconds** (float). |
| `end` | number | End in **seconds** (float). |
| `text` | string | The word, without its trailing space. |
| `space` | bool | `true` = a word boundary (space) follows the word. `false` = fragment glued to the next one (e.g. hyphenated words split by the engine). Default when absent: `true`. |
| `struck` | bool | `true` = **redacted** word (struck out): excluded from playback and from every export, but text and timings remain. Default when absent: `false`. **Do not serialize defaults** (smaller files, backward compatibility with pre-existing JSON). |

**`paragraphs[]`** — the paragraph/turn structure:

| Field | Type | Description |
|---|---|---|
| `speaker` | string \| null | Speaker name (without square brackets), or `null` if unattributed. |
| `start` / `end` | number | Temporal extent of the paragraph in seconds. Words belong to the paragraph that temporally contains them. |

Rules:

- Times are **seconds** (float) throughout the JSON. (The editor's DOM uses
  integer milliseconds — `data-m`/`data-d`; the conversion is
  `ms = round(s × 1000)`; § 12.)
- Redactions (`struck`) are **working state** and travel in the save. They
  are reversible in the editor; they become final only in an export.
- In v1, redaction is **word-level only** (`struck`), complemented by
  gap-removal in `options`. Time-range redaction may arrive as a future
  additive field `redactions: [{start, end}]` (minor bump, e.g. v1.1) if a
  real need emerges.

---

## 4. `transcript.html` — the compatibility copy

The transcript in the **editor's native format**: HTML with one `<span>` per
word.

```html
<article><section>
  <p>
    <span class="speaker" data-m="320" data-d="0">[Maria] </span>
    <span data-m="320" data-d="520">Benvenuti </span>
    <span data-m="840" data-d="180" style="text-decoration: line-through;">ehm </span>
  </p>
</section></article>
```

Conventions of the HTML format (the editor's current ones):

- `data-m` = start in **milliseconds** (integer); `data-d` = duration in
  milliseconds.
- The **trailing space inside the span** encodes the word boundary
  (equivalent to `space: true` in the JSON).
- Speakers are dedicated spans: `class="speaker"`, `data-d="0"`, text
  `[Name] `.
- Redactions are `style="text-decoration: line-through"` on the span
  (equivalent to `struck: true`).

Role:

1. **Compatibility**: existing HTML-based flows (hyperaudio-lite, legacy
   storage) consume it without converters.
2. **Inspectability**: opening the zip, a browser displays the transcript
   directly.
3. **Safety net**: if the JSON round-trip ever had a bug, the editor's data
   is still there.

**Anti-divergence rule:** the source of truth is
`hyperaudio.json.transcript`. The writer **MUST** generate `transcript.html`
from the same state in the same save (the two files are consistent by
construction).

**Fallback rules:** the reader **MUST** load from the JSON; using
`transcript.html` as a source is allowed **only as recovery**, when the JSON
is missing or unreadable. In that case the reader:

- **MUST** sanitize the HTML against the allowlist in § 10 before any DOM
  insertion;
- **SHOULD** warn the user that the file is not fully conforming and was
  recovered from the HTML;
- **SHOULD** regenerate the complete JSON at the next save, bringing the
  project back to full conformance.

---

## 5. `transcript.original.json` — the origin (optional, immutable)

The transcription **as it came out of the engine**, before any human
intervention. It is non-reconstructible working state: the moment the user
edits, the original would be gone — and re-transcribing costs time/money and
never yields the exact same result.

**Schema: identical to the `transcript` object** of `hyperaudio.json`
(§ 3.6) — `{ "words": [...], "paragraphs": [...] }`, times in seconds. A
diff between origin and working copy is then a direct comparison of equal
structures.

Rules:

- The writer writes it **once**, at transcription time (or at import, if the
  origin is kept), and **MUST NOT** ever modify it afterwards. It is the
  conceptual twin of the media: it enters at the start and is never touched.
- It **MUST NOT** contain `struck`: redaction is the user's work, absent from
  the origin by definition.
- Speakers are those assigned by the engine (e.g. `"Speaker 0"`), not the
  names the user will assign later.
- The reader **MUST** tolerate its absence and **MUST NOT** load it as the
  working transcript, except on an explicit user action (e.g. "restore
  original").
- It is referenced by `provenance.originalTranscript` (§ 3.5); if the file
  exists but the field is missing (or vice versa), the reader trusts the
  file.

What it enables (future features, none required in v1): a "what did I
change" diff view, restoring a word/region to the original, re-alignment,
engine quality metrics.

**The origin always travels in the file**: stripping it from the save would
only make sense if it were public and retrievable online — it is not, so the
file is the only place it lives. There is no "save without origin" option in
v1.

⚠️ **Privacy note:** the origin contains the *pre-redaction* text — words the
user struck out or deleted in the working copy are still there. Within a save
this creates no new exposure class (the container already includes the
original media, which contains all the audio), but any future *sharing*
feature that strips the file (e.g. "share without media") **MUST** consider
stripping this file too.

---

## 6. `captions.vtt` — the current captions

The project's sentence-level captions, in standard WebVTT.

### 6.1 ⚠️ Transcript and captions MUST be allowed to diverge

This is the most important conceptual point of the format, and the reason
captions are a file of their own rather than a derivative recomputed on open.

**Transcript and captions are two representations of the same speech with two
different purposes:**

- The **transcript** is the *display and editing* view: faithful word by
  word, with word-level timing, redactions included. It is the document you
  work on — the equivalent of the timeline.
- The **captions** are the *reading* view: text segmented into cues sized to
  be **read** while watching — short lines (~37 characters), minimum
  duration, sustainable reading speed (~17 characters/second), line breaks
  placed where the sentence breathes.

A good subtitle is **not** a faithful transcription: it may omit a
hesitation, compact a repetition, break a line at a different point, nudge a
cue by a few tenths of a second to give it time to be read. Whoever curates
subtitles in caption mode produces **irreplaceable user data**, not a
derivative.

The contract is governed by `options.captions.updateFromTranscript`:

| Value | Meaning | Reader obligation |
|---|---|---|
| `true` | The captions are **derived**: the editor regenerates them on every transcript edit. The saved VTT is the latest generation (included because it makes the file readable by a player with no segmentation logic). | May regenerate them freely. |
| `false` | The captions are **hand-curated** and legitimately diverge from the transcript. | **MUST NOT** regenerate or "fix" them to re-align them to the transcript. Touch them only on an explicit user action. |

Corollary for every reader (including automated tools and LLMs processing the
format): **never "repair" a file by re-aligning captions and transcript**. If
they diverge with `updateFromTranscript: false`, the divergence is
intentional.

### 6.2 What this file is NOT

- It is not the word-level karaoke VTT: that is an artifact always
  deterministically derivable from the transcript and **MUST NOT** be in the
  container.
- It is not the burned-in caption of an export: that is produced from the
  re-timed transcript at export time and is not working state.

### 6.3 Multilingual captions (roadmap)

`captions.vtt` at the root is and will remain **the primary track, forever**
— including in a multilingual future. Additional tracks will arrive as an
additive minor bump: `captions/<lang>.vtt` files declared in
`hyperaudio.json`. v1 readers will keep working by finding the primary; the
extra tracks are simply unknown files to ignore (§ 2).

---

## 7. `media/` — the project media

### 7.1 v1 rules (`kind: "original"`)

- The file enters the container **byte for byte, never re-encoded**. The
  original name is preserved (`media/<filename>`).
- In the zip, the media entry **MUST** use the **STORE** method (no
  compression): media formats are already compressed; deflate would gain ~0%
  while burning CPU on files hundreds of MB large. JSON/HTML/VTT are
  compressed normally (deflate). Since 1.2, readers **MUST** treat a media
  entry whose zip method is not STORE as non-conforming (§ 7.3 applies): a
  compressed media entry defeats the size accounting of § 10.3.
- One media file per project.

### 7.2 Future formulas (roadmap, not v1)

The `media.kind` field is the enum that makes these evolutions a non-breaking
minor bump:

| `kind` | Content | Status |
|---|---|---|
| `"original"` | The original file in `media/` | **v1 — the only initial formula** |
| `"audio-m4a"` | Only the audio track, re-encoded M4A/AAC: a compact save for projects where the video weighs GBs but the work is on the text. An **explicit user choice** at save time, never automatic. | future |
| `"link"` | No file in the container: `url` points to media on the web. The file is not self-contained and the editor states so openly. | **v1.1** (§ 7.2.1) |
| `"none"` | No media at all: a text-only project (e.g. a JSON/SRT/VTT import with no media attached). | **v1.2** (§ 7.2.2) |

### 7.2.1 `kind: "link"` (since 1.1)

- `url` **MUST** be an http(s) URL; `path` is `null`; the container has no
  `media/` entry.
- The file is **not self-contained**, and readers state so openly on open.
- Writers **SHOULD** prefer embedding over linking: attempt to download the
  remote media and save it as `kind: "original"` (whether this works is the
  server's call — CORS); fall back to a link save only with the user informed.
- Readers open a link project by playing the URL directly (playback does not
  require CORS). If the URL is unreachable, § 7.3 applies — degraded mode
  with reconciliation is the recommended behaviour.

### 7.2.2 `kind: "none"` (since 1.2)

- A project with **no media at all** — the normal state of a text-only import
  (JSON/SRT/VTT with no media attached). `path` and `url` are `null`;
  `filename` **MAY** be `""`.
- Writers **MUST** use `"none"` rather than fabricating an `"original"`
  descriptor that points at a nonexistent entry ("editable but not saveable"
  was the alternative, and it is worse).
- Readers **MUST** load such projects with playback disabled, and **MAY**
  offer to attach media; attaching upgrades the descriptor to `"original"`
  (or `"link"`) at the next save. § 7.3 reconciliation does not apply —
  nothing is *missing*.

### 7.3 Media unavailable: degraded mode and reconciliation

When the media is unusable — unknown `kind` (written by a newer version),
`kind: "link"` with an unreachable URL, or a tampered container — the reader
**MUST NOT** load the project as if nothing happened. Two conforming
behaviours:

1. **Rejection** with a clear message (the default; this is what Hyperaudio
   Lite Editor v1 does).
2. **Degraded mode** (MAY): load the text only (transcript/captions),
   explicitly stating that the media is unavailable.

In degraded mode the reader **MAY** offer **reconciliation**: ask the user to
provide the media file and re-attach it to the project. Verification criteria
in v1: `durationSeconds`, `sizeBytes`, `filename` (heuristic); once a
`sha256` checksum lands in the descriptor in v1.x, reconciliation becomes
certain. Re-attaching rewrites the `media` descriptor (back to
`kind: "original"`) at the next save.

---

## 8. Versioning

`formatVersion` is a `"major.minor"` string.

- **minor bump** (`1.0` → `1.1`): backward-compatible additions — new fields,
  new files in the container, new values where the reader has a safe fallback
  behaviour. Readers **MUST ignore** unknown fields and files.
- **major bump** (`1.x` → `2.0`): breaking changes. A reader that encounters
  a major version above its own **MUST reject** the file with a clear message
  ("this project requires a newer version of the editor"), without attempting
  a partial load.
- Writers always write the most recent version they know and **MUST NOT**
  silently rewrite a file to a lower version.

*Ignore-unknown + reject-major* is the pair of rules that lets the format
evolve for years without breaking native apps born later.

Version history: **1.0** initial; **1.1** adds `media.kind: "link"`
(§ 7.2.1); **1.2** adds `media.kind: "none"` (§ 7.2.2), makes writer-side
preservation of unknown fields normative (§ 8.1), requires STORE for media
entries on read (§ 7.1), and pins the `media.path` segment rule and the
byte-measured size caps (§ 10.2, § 10.3).

Documented exception: unknown `media.kind` → the project is not normally
loadable even within the same major; the behaviours of § 7.3 apply.

### 8.1 Round-trip preservation (normative since 1.2)

*Ignore-unknown* (readers) is only half the promise: a writer that rebuilds
`hyperaudio.json` from scratch destroys the very fields readers were told to
tolerate. On rewriting an opened project, writers **MUST** start from the
opened envelope and overwrite only the fields they own — including *inside*
known objects (`options`, `texts`, …), where unknown keys **MUST** be
preserved rather than the object replaced wholesale. A conforming open→save
round trip preserves every unknown top-level field and every unknown nested
field.

---

## 9. What must NEVER be in the container

1. **API keys, tokens, credentials** — of any service, in any field.
2. **Application preferences** (preferred engine, UI language, etc.) — only
   *project* settings belong here.
3. **Derived artifacts**: edited media, burned-in captions, karaoke VTT,
   re-timed transcript.
4. **Data from other projects**, or editor history.
5. **App/session identity and storage bookkeeping** — working-copy project
   IDs, tab/session identifiers, dirty flags, autosave state. Project
   identity is application state; two apps sharing a file must never fight
   over it inside the container.

---

## 10. Reader security (normative)

A `.hyperaudio` file comes from the outside: the reader treats it as
**untrusted input**.

### 10.1 Whitelist-read: never generic extraction

The reader **MUST NOT** iterate the zip entries extracting them or writing
them to paths taken from the file. It reads **only entries with known
names**: `mimetype`, `hyperaudio.json`, `transcript.html`,
`transcript.original.json`, `captions.vtt`, plus the media indicated by
`media.path`. Every other entry is ignored (§ 2). This neutralises path
traversal (`../`, absolute paths) *by design*: no path from the file is ever
used as a write destination.

### 10.2 Constraints on `media.path`

- **MUST** match the pattern `media/<filename>`: exactly one non-empty
  segment after `media/` — no `/` or `\\` anywhere within it, and the segment
  **MUST NOT** be exactly `.` or `..`. A `..` **substring** inside an
  otherwise normal filename (`mix..final.mp3`) is legal and **MUST** be
  accepted — pinned in 1.2 after a reject-any-substring reading made
  conforming containers unreadable. Writers **MUST** sanitize embedded media
  filenames with this same rule.
- **MUST** correspond to an existing entry in the zip.
- Only that entry is read as media; any other file in `media/` is ignored.

On violation, the reader **MUST** treat the media as unavailable (§ 7.3).

### 10.3 Size limits (anti zip-bomb)

Before decompressing, the reader **SHOULD** enforce reasonable ceilings on
the textual entries (indicative: 50 MB each for `hyperaudio.json`,
`transcript.html`, `transcript.original.json`, `captions.vtt` — a one-hour
transcription is on the order of hundreds of KB). Entries above the ceiling →
the file is treated as non-conforming. Since 1.2 the ceilings are pinned as
**UTF-8 bytes** (declared size pre-inflate and actual size post-inflate), not
UTF-16 code units; readers decode text entries with a **fatal** UTF-8 decoder
and treat invalid UTF-8 as non-conforming.

### 10.4 JSON validation

The reader **MUST** validate types and ranges before use: numeric times
finite and non-negative, `start ≤ end`, well-formed `formatVersion`,
`media.kind` among the handled values. Malformed or invalid JSON =
"unreadable JSON" → the recovery path from `transcript.html` applies (§ 4).

### 10.5 Safe DOM construction

- Primary path (from the JSON): the reader **MUST** build the DOM
  programmatically, using `textContent` for all text — never `innerHTML` on
  data coming from the file.
- Recovery path (from `transcript.html`): the reader **MUST** sanitize
  against an allowlist before any DOM insertion — allowed elements:
  `article`, `section`, `p`, `span`; allowed attributes: `data-m`, `data-d`,
  `class` (value `speaker` only), `style` (only
  `text-decoration: line-through`). Everything else — scripts, `on*`
  handlers, iframes, links, images, other styles — is removed.

### 10.6 Duplicate entries

With whitelist-read, duplicate entries are not an attack vector (a single
entry per name is read — the one the zip library deterministically exposes).
Readers **SHOULD** nevertheless not depend on entry order, `mimetype`
excepted.

---

## 11. Conformance checklist

**A conforming writer:**

- [ ] writes `mimetype` as the first entry, STORE, exact content
- [ ] writes `hyperaudio.json` with all required fields, times in seconds,
      defaults (`space: true`, `struck: false`) not serialized
- [ ] writes `transcript.html` and `captions.vtt` consistent with the JSON of
      the same save
- [ ] writes `transcript.original.json` once (at transcription time) and
      never modifies it again
- [ ] writes the media byte for byte, STORE entry, name preserved — or, for
      a link save (§ 7.2.1), no media entry and an http(s) `url`
- [ ] never writes keys/credentials/derived artifacts

**A conforming reader:**

- [ ] checks `format === "hyperaudio"` and applies the version rules (§ 8)
- [ ] reads only entries with known names; validates `media.path` and the
      size limits (§ 10)
- [ ] validates JSON types and ranges before use (§ 10.4)
- [ ] loads the transcript from `hyperaudio.json`, building the DOM with
      `textContent`; uses `transcript.html` only as recovery, sanitized
      (§ 4, § 10.5)
- [ ] honours `captions.updateFromTranscript: false` (never
      regenerate/re-align)
- [ ] never loads `transcript.original.json` as the working transcript
      (explicit user action only)
- [ ] on unavailable media: rejects with a clear message, or degrades while
      stating it (§ 7.3)
- [ ] ignores unknown fields and files
- [ ] tolerates the absence of `mimetype`, `transcript.html`,
      `transcript.original.json`, `captions.vtt`

---

## 12. Invariants and known traps

| Invariant | Why it matters |
|---|---|
| JSON in **seconds** (float), DOM/HTML in **milliseconds** (integers) | The off-by-1000 error is the classic fatal bug of this domain. Conversion: `ms = round(s × 1000)`; maximum loss 0.5 ms, irrelevant. |
| Trailing space in the HTML span = `space: true` in the JSON | The word boundary is *data*, not formatting. Losing it glues words together. |
| `struck` travels in the save, is applied at export | Redactions are reversible as long as you are in the working file. |
| Captions ≠ transcript (§ 6.1) | Never "repair" the divergence: with `updateFromTranscript: false` it is intentional. |
| Origin ≠ working copy (§ 5) | `transcript.original.json` is immutable and pre-redaction: never load it in place of the working transcript, never "update" it. |
| The file is untrusted input (§ 10) | Whitelist-read, validation, DOM via `textContent`, sanitization of the HTML fallback. |
| UTF-8 everywhere | Media filenames included (the zip's UTF-8 flag). |
| One media file, original name | No ambiguity, no index to maintain. |



<details>
<summary><strong>Worked example — a complete, valid container</strong></summary>

Zipping these entries (with `mimetype` first and uncompressed) produces a
valid `.hyperaudio` file (a 1.0 file — still valid under 1.1, which is a
purely additive minor bump). The example demonstrates the two key contracts:
caption divergence (§ 6.1 — the transcript contains the redacted hesitation
"ehm", the hand-curated captions omit it) and the immutable origin (§ 5 — the
engine produced "hyper" + "audio" as two lowercase words; the user merged
them into "Hyperaudio,").

### `mimetype`

```
application/vnd.hyperaudio+zip
```

### `hyperaudio.json`

```json
{
  "format": "hyperaudio",
  "formatVersion": "1.0",
  "generator": { "name": "hyperaudio-lite-editor", "version": "0.8.2" },
  "created": "2026-07-10T09:00:00Z",
  "modified": "2026-07-10T11:30:00Z",

  "media": {
    "kind": "original",
    "path": "media/intervista-maria.mp4",
    "url": null,
    "filename": "intervista-maria.mp4",
    "mimeType": "video/mp4",
    "durationSeconds": 62.5,
    "sizeBytes": 48211337
  },

  "options": {
    "gapRemoval": { "enabled": true, "thresholdMs": 500, "bufferMs": 100 },
    "captions": { "updateFromTranscript": false },
    "view": { "showSpeakers": true, "showTimecodes": false }
  },

  "texts": {
    "title": "Intervista con Maria — formato di salvataggio",
    "language": "it",
    "summary": "Maria e Piero presentano il nuovo formato di salvataggio .hyperaudio.",
    "topics": ["hyperaudio", "formato file", "salvataggio"]
  },

  "provenance": {
    "engine": "deepgram",
    "model": "nova-3",
    "transcribedAt": "2026-07-10T08:55:00Z",
    "originalTranscript": "transcript.original.json"
  },

  "transcript": {
    "words": [
      { "start": 0.32, "end": 0.84, "text": "Benvenuti" },
      { "start": 0.84, "end": 1.02, "text": "ehm", "struck": true },
      { "start": 1.1, "end": 1.3, "text": "a" },
      { "start": 1.3, "end": 2.1, "text": "Hyperaudio," },
      { "start": 2.3, "end": 2.55, "text": "il" },
      { "start": 2.55, "end": 3.1, "text": "modo" },
      { "start": 3.15, "end": 3.4, "text": "più" },
      { "start": 3.45, "end": 4.05, "text": "semplice" },
      { "start": 4.1, "end": 4.3, "text": "di" },
      { "start": 4.35, "end": 5.0, "text": "montare" },
      { "start": 5.05, "end": 5.3, "text": "un" },
      { "start": 5.35, "end": 6.1, "text": "video" },
      { "start": 6.15, "end": 6.5, "text": "trascritto." },
      { "start": 7.8, "end": 8.2, "text": "Grazie" },
      { "start": 8.25, "end": 8.7, "text": "Maria," },
      { "start": 8.9, "end": 9.3, "text": "oggi" },
      { "start": 9.35, "end": 9.9, "text": "parliamo" },
      { "start": 9.95, "end": 10.15, "text": "del" },
      { "start": 10.2, "end": 10.75, "text": "formato" },
      { "start": 10.8, "end": 10.95, "text": "di" },
      { "start": 11.0, "end": 11.85, "text": "salvataggio." }
    ],
    "paragraphs": [
      { "speaker": "Maria", "start": 0.32, "end": 6.5 },
      { "speaker": "Piero", "start": 7.8, "end": 11.85 }
    ]
  }
}
```

### `transcript.html`

```html
<!-- Compatibility copy: the transcript in the editor's native format.
     Source of truth: hyperaudio.json → transcript (this file is generated from the same save).
     data-m = start in milliseconds, data-d = duration in milliseconds.
     The trailing space inside each span encodes the word boundary.
     style="text-decoration: line-through" = redacted word (struck in the JSON). -->
<article><section>
  <p>
    <span class="speaker" data-m="320" data-d="0">[Maria] </span>
    <span data-m="320" data-d="520">Benvenuti </span>
    <span data-m="840" data-d="180" style="text-decoration: line-through;">ehm </span>
    <span data-m="1100" data-d="200">a </span>
    <span data-m="1300" data-d="800">Hyperaudio, </span>
    <span data-m="2300" data-d="250">il </span>
    <span data-m="2550" data-d="550">modo </span>
    <span data-m="3150" data-d="250">più </span>
    <span data-m="3450" data-d="600">semplice </span>
    <span data-m="4100" data-d="200">di </span>
    <span data-m="4350" data-d="650">montare </span>
    <span data-m="5050" data-d="250">un </span>
    <span data-m="5350" data-d="750">video </span>
    <span data-m="6150" data-d="350">trascritto. </span>
  </p>
  <p>
    <span class="speaker" data-m="7800" data-d="0">[Piero] </span>
    <span data-m="7800" data-d="400">Grazie </span>
    <span data-m="8250" data-d="450">Maria, </span>
    <span data-m="8900" data-d="400">oggi </span>
    <span data-m="9350" data-d="550">parliamo </span>
    <span data-m="9950" data-d="200">del </span>
    <span data-m="10200" data-d="550">formato </span>
    <span data-m="10800" data-d="150">di </span>
    <span data-m="11000" data-d="850">salvataggio. </span>
  </p>
</section></article>
```

### `transcript.original.json`

```json
{
  "words": [
    { "start": 0.32, "end": 0.84, "text": "benvenuti" },
    { "start": 0.84, "end": 1.02, "text": "ehm" },
    { "start": 1.1, "end": 1.3, "text": "a" },
    { "start": 1.3, "end": 1.7, "text": "hyper" },
    { "start": 1.75, "end": 2.1, "text": "audio" },
    { "start": 2.3, "end": 2.55, "text": "il" },
    { "start": 2.55, "end": 3.1, "text": "modo" },
    { "start": 3.15, "end": 3.4, "text": "più" },
    { "start": 3.45, "end": 4.05, "text": "semplice" },
    { "start": 4.1, "end": 4.3, "text": "di" },
    { "start": 4.35, "end": 5.0, "text": "montare" },
    { "start": 5.05, "end": 5.3, "text": "un" },
    { "start": 5.35, "end": 6.1, "text": "video" },
    { "start": 6.15, "end": 6.5, "text": "trascritto" },
    { "start": 7.8, "end": 8.2, "text": "grazie" },
    { "start": 8.25, "end": 8.7, "text": "maria" },
    { "start": 8.9, "end": 9.3, "text": "oggi" },
    { "start": 9.35, "end": 9.9, "text": "parliamo" },
    { "start": 9.95, "end": 10.15, "text": "del" },
    { "start": 10.2, "end": 10.75, "text": "formato" },
    { "start": 10.8, "end": 10.95, "text": "di" },
    { "start": 11.0, "end": 11.85, "text": "salvataggio" }
  ],
  "paragraphs": [
    { "speaker": "Speaker 0", "start": 0.32, "end": 6.5 },
    { "speaker": "Speaker 1", "start": 7.8, "end": 11.85 }
  ]
}
```

### `captions.vtt`

```
WEBVTT

NOTE
HAND-CURATED captions (options.captions.updateFromTranscript = false).
They legitimately diverge from the transcript: the hesitation "ehm" is
omitted, line breaks are chosen for reading, and the second cue extends
past the end of its last word (6.5s -> 6.7s) to leave time to read it.
A conforming reader MUST NOT regenerate them or re-align them to the
transcript.

00:00:00.320 --> 00:00:03.100
Benvenuti a Hyperaudio,
il modo più semplice

00:00:03.150 --> 00:00:06.700
di montare un video trascritto.

00:00:07.800 --> 00:00:11.850
Grazie Maria, oggi parliamo
del formato di salvataggio.
```

### `media/`

In a real file this folder contains the original media, byte for byte, with
its filename preserved (here: `intervista-maria.mp4`, a STORE entry). Omitted
from this example.

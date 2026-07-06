# WebGPU and local transcription: browser implementation notes

How the browsers' WebGPU implementations differ, and why that dictates the
Parakeet (Local) tab's per-browser defaults. Written 2026-07; this is one of
the fastest-moving corners of the web platform, so re-verify the per-browser
conclusions every few releases (see [Revisiting the defaults](#revisiting-the-defaults)).

Related code: `js/parakeet.worker.js` (capability probe, execution-provider
selection, fallback), `js/hyperaudio-lite-editor-parakeet-local.js` (per-browser
defaults and the GPU opt-in UI). Related history: #308 (Firefox WebGPU
findings), #309 (local Parakeet spike), #325 (the Parakeet tab), the 0.6.8
Safari lockup and the 0.6.9 safe-default/opt-in response.

---

## Why the GPU decision dominates the experience

Parakeet TDT 0.6B v3 runs in three ONNX sessions:

| Stage | Share of compute | Execution provider |
|---|---|---|
| mel spectrogram (`nemo128.onnx`) | small | WASM, always |
| **encoder** | **~93%** | **WebGPU (fp16) or WASM (int8)** — the whole question |
| TDT decoder/joint | ~7% | WASM, always — a cheap per-token loop; GPU round-trips would cost more than they save |

The encoder ships in two builds, and the browser's WebGPU quality decides
which one a user gets:

| Build | Size | Path | Throughput (M4 Pro reference) |
|---|---|---|---|
| fp16 | ~1.24 GB | WebGPU | ~100–120× realtime |
| int8 | ~652 MB | WASM/CPU | ~3× realtime single-threaded (GitHub Pages today, no cross-origin isolation); ~10× with COI multithreading |

That ~40× gap is why "GPU or not" is the single most consequential
per-browser decision in the editor. Note the choice also selects **which model
gets downloaded** — a user who toggles modes caches both (~1.9 GB total in
Cache Storage).

---

## One spec, three implementations

WebGPU is a W3C spec with three fully independent implementations. The
differences below are architectural, not cosmetic — each one maps onto a
symptom we observed.

### Chrome / Chromium — Dawn + Tint (C++)

- **Dawn** is the runtime, **Tint** compiles WGSL to the platform's shader
  language. Abstraction over **D3D12** (Windows), **Metal** (macOS), **Vulkan**
  (Android/Linux), plus a compat mode for older GPUs.
- Shipped first (Chrome 113, May 2023) → years of production hardening.
- Runs in Chromium's sandboxed GPU process with a watchdog.
- First to ship the ML-relevant optional features: **`shader-f16`** (real
  half-precision — what lets the fp16 encoder actually run as fp16) and
  **subgroups** (fast matmul reductions).
- Dawn is also an embeddable library used outside Chrome, broadening its
  testing surface.
- **Result for Parakeet: the happy path.** GPU/fp16 by default, no prompt.

#### Chromium derivatives (Brave, Opera, Edge, Vivaldi, Arc…)

Same Blink + Dawn stack → behave like Chrome of the same Chromium version.
Caveats: they can lag Chrome by a few versions (late-arriving features),
**Brave's fingerprinting shields can mask/perturb adapter info** (worst case
our probe under-detects and degrades to CPU — never breaks), and vendors can
flip individual feature flags. Our detection is capability-based, so
derivatives land on the Chrome path automatically.

### Firefox — wgpu + naga (Rust)

- Firefox's implementation **is** the Rust ecosystem's `wgpu` crate (Bevy,
  Deno, much of Rust graphics), with **naga** as the WGSL compiler. Same
  abstraction idea as Dawn (Vulkan/Metal/D3D12 underneath).
- Shipped much later (Windows mid-2025, other platforms trailing);
  correctness-first, performance-second — a defensible strategy whose perf
  phase is still under way.
- **The #308 finding: Firefox's WebGPU ran our encoder *slower than Firefox's
  own WASM path*.** Defaulting Firefox to GPU would be a downgrade. Causes,
  best understood:
  - **naga codegen**: WebGPU requires memory-safe shader execution; naga leans
    on per-access bounds clamps where Tint does more analysis to hoist or
    eliminate them. A redundant clamp per load inside a matmul inner loop is
    catastrophic.
  - **Missing/late ML features**: without `shader-f16`, a "fp16" model runs as
    emulated f32 — double the memory traffic, none of the benefit; subgroups
    arrived later than in Chrome.
  - **Per-dispatch overheads**: wgpu's validation/state tracking per
    submission plus Firefox's content↔GPU-process IPC — amortised fine by
    graphics workloads, painful for chatty ML graphs.
  - **The tuning loop**: onnxruntime-web's WebGPU kernels are developed and
    benchmarked overwhelmingly against Dawn, hitting Dawn's fast paths by
    construction. The same WGSL through naga can land on unoptimised paths.
    Some of the gap is co-evolution, not implementation quality per se.
- Structural advantage: wgpu is co-funded and battle-tested by a whole
  ecosystem outside the browser. Expect this gap to close faster than
  Safari's memory one — it's an optimisation problem, not a philosophy
  problem.
- **Result for Parakeet: CPU/int8 by default**, GPU opt-in behind a mild
  warning ("experimental; may error or run poorly — it should not crash your
  OS"), largely to gather real-world data as releases improve.

### Safari — WebKit's own implementation, Metal-only

- No abstraction layer at all: Apple only ships on Apple platforms, so WebKit
  compiles WGSL straight to **MSL** on **Metal** — architecturally the
  cleanest mapping of the three (WebGPU's design borrowed heavily from Metal).
- Shipped last (Safari 26, late 2025) after a long Tech Preview.
- The GPU code is not the problem. **WebKit's memory governance is** — see the
  next section. On v0.6.8, running the fp16 encoder didn't error or slow
  down; it **froze the entire Mac**.
- **Result for Parakeet: CPU/int8 by default**, GPU opt-in behind a stern
  warning ("this can use enough memory to freeze your computer — save your
  work first"). Until WebKit's enforcement fails *gracefully*, the person
  clicking the box is the safety mechanism.

---

## Memory philosophies: why Safari's ceiling is so hard, and whether Chrome is reckless

### Safari: the ceiling explained

Four forces stack:

1. **iOS heritage.** WebKit is one engine for all Apple devices, and its
   memory discipline was forged on iPhones, where **there is no swap** — the
   kernel kills processes under pressure (jetsam) rather than paging. WebKit
   grew strict per-process budgets and a reflex of treating memory-hungry
   pages as misbehaving pages; macOS Safari inherits that machinery wholesale.
2. **Apple Silicon unified memory.** GPU memory *is* system RAM — one physical
   pool, one allocator. Metal resources in active use by in-flight GPU work
   are effectively **wired**: they can't be compressed or paged while the
   encoder is grinding, which for a long transcription is continuously. A
   1.24 GB model + activations removes several GB of *unpageable* memory from
   a machine that may have 8–16 GB total.
3. **WindowServer shares the GPU.** The compositor is also a Metal client
   competing for the same GPU and memory. When it starves, the cursor and
   screen stop responding — which is why the failure was a whole-Mac freeze
   rather than a tab crash. On unified memory, one page's GPU appetite is
   everyone's problem.
4. **Young enforcement.** The WebGPU spec has graceful answers — conservative
   `limits`, allocation failures, device-lost errors — and mature
   implementations self-police *before* the OS suffers. Safari's
   implementation shipped years later; the v0.6.8 lockup suggests allocations
   were granted past the point of system health instead of failing fast. The
   guard rails existed on paper but didn't bite in time. This is the sort of
   gap that closes with production mileage.

Plus deliberate posture: Apple treats web content as maximally untrusted and
resource caps as part of the sandbox (anti-abuse, battery/thermal, device
stability). A gigabyte-scale ML workload in a web page is a legitimate
instance of exactly the pattern those caps exist to be suspicious of.

The irony: the hardware under Safari is *excellent* for this workload — the
same unified-memory GPU runs Parakeet fast with the OS's blessing when asked
via CoreML in a native app (which is precisely GliderMac's role on macOS).
The ceiling is the browser's contract with web content, not the silicon.

### Chrome: permissive, but engineered — not reckless

Chrome lets a page use far more, and in exchange builds machinery so the
*page* pays for its own excess, not the system:

- **Dawn tracks its own budgets** and fails allocations / detonates the
  WebGPU device (`device lost`) before the OS feels it. The tab survives.
  This rehearsal of the failure path is what makes the fp16 encoder safe in
  Chrome on the same Mac, through the same Metal API.
- **The GPU process is a bulkhead** — one sandboxed process for all tabs'
  GPU work, with a watchdog; if it wedges, Chrome kills and restarts it
  (every tab's canvas blinks and recovers — a contained crash by design).
- **Renderers die gracefully** ("Aw, Snap" is per-tab OOM enforcement — the
  polite jetsam).
- On **Android** — a no-swap jetsam world like iOS — Chrome runs a far
  stricter version of the same playbook, so the tight-budget approach is a
  choice per platform, not an inability.

Honest criticisms of the permissive stance: it **externalises soft
pressure** (a page can push an 8 GB machine deep into swap before any limit
bites — the system stays alive but everything degrades; Safari's caps
genuinely protect low-RAM machines from that misery); budget heuristics are
tuned numbers, not contracts, and bugs have slipped the gap; multiplied by
tab count it's the "Chrome ate my RAM" reputation.

Fair framing: **Apple draws the safety boundary at the device; Google draws
it at the tab.** Neither is reckless — they optimise for different worst
cases (the device drowning vs the page dying well). For gigabyte-scale ML in
a tab, the tab-boundary philosophy happens to be the right one today.

### What we'd recommend to Mozilla (for the record)

1. **Shader codegen quality first** — especially bounds-check elimination in
   naga (hoist/eliminate clamps the way Tint does); ML kernels expose naïve
   codegen in ways short graphics shaders don't.
2. **Ship the ML feature set** (`shader-f16`, subgroups, the coming
   subgroup-matrix ops) — these gate whether inference libraries can even
   use the fast paths.
3. **Fix the tuning loop**: put real inference stacks (onnxruntime-web,
   transformers.js) into continuous perf testing and engage those
   maintainers; today their kernels hit Dawn's fast paths by construction.
4. **Shave runtime overheads**: cached pipeline/bind validation, batched
   submissions, shared-memory `mapAsync` fast paths, persistent shader cache.
5. **Adopt Dawn-style memory budgets + graceful device-loss now**, while
   big-model workloads on Firefox are rare — learn from Safari's lesson in
   the good times.
6. **Standardised coarse adapter buckets** (integrated/discrete/software,
   rough tier) to reconcile fingerprinting caution with apps' legitimate
   need to pick an execution path without UA-sniffing.

---

## The detection layers as shipped

Three layers, in `js/parakeet.worker.js` and the Parakeet client:

1. **`navigator.gpu` existing means nothing.** Headless and GPU-less machines
   expose the API but yield no adapter; Chrome can also hand out a
   SwiftShader **software** adapter that "is WebGPU" but computes on CPU. The
   worker requires a non-null `requestAdapter()` before attempting a WebGPU
   session.
2. **Per-browser policy**: Firefox and Safari default to CPU/int8 (for the
   two different reasons above), with opt-in checkboxes read at submit time —
   Firefox's warning proportionate to "may run poorly", Safari's to "may
   freeze your machine".
3. **Runtime fallback**: if WebGPU session creation or warm-up fails even on
   the happy path, the worker rebuilds once on WASM/int8 rather than dying.

## Revisiting the defaults

- Both wgpu and WebKit are improving quickly; **recheck the Firefox and
  Safari defaults every ~6 months** (re-run the #308-style comparison: encoder
  window time on WebGPU vs WASM in that browser).
- The cleaner long-term mechanism than UA policy: a **first-run
  micro-benchmark** — time a small matmul on the adapter vs WASM, cache the
  verdict, and let any browser graduate to the GPU path the release it
  becomes worth it. Worth doing next time the worker's selection logic is
  touched.
- Keep the WASM path healthy regardless (SIMD; cross-origin isolation would
  unlock multithreading ≈ 3×→10×) — on Firefox today, WASM *is* the fast
  path, and it's the universal fallback everywhere else.

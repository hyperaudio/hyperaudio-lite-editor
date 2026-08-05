// Soak test: caption-mode toggling must not leak.
//
// A long editing session toggles between transcript view and captions view many
// times. Each round trip does a lot of teardown/rebuild work — entering clones
// .transcript-holder into transcriptCache, replaces its innerHTML with the
// caption editor and rebuilds the <track> (editor-core.js
// hyperaudioGenerateCaptionsFromTranscript); leaving wipes the holder, re-inserts
// the cached #hypertranscript and calls hyperaudio() again, which re-runs the
// player's whole init (editor-main.js restoreTranscript). Anything that binds a
// listener or stashes a node clone on that path and never releases it accumulates
// silently: nothing looks wrong after one toggle, the tab is sluggish after a
// hundred.
//
// So: repeat the toggle, and measure at the SAME phase of the cycle every time
// (back in transcript view, after a forced GC). A healthy cycle returns to the
// same DOM node count and listener count each pass; a leak shows up as a straight
// line sloping up. We fit a least-squares trend over the samples rather than
// comparing first-to-last, so one noisy reading can't decide the result.
//
// Chromium only — the counters come from the DevTools Protocol
// (Performance.getMetrics), which has no WebKit/Firefox equivalent.
//
// Not part of the e2e suite: it takes minutes and is inherently a trend
// measurement, so it lives in its own project (playwright.soak.config.mjs,
// `npm run test:soak`) and is meant for nightly/on-demand runs, not per-push.
//
// Knobs (env): SOAK_PASSES, SOAK_WARMUP, SOAK_SAMPLE_EVERY,
// SOAK_NODE_LIMIT, SOAK_LISTENER_LIMIT, SOAK_HEAP_LIMIT.
import { test, expect } from '@playwright/test';

const PASSES = Number(process.env.SOAK_PASSES || 120);
const WARMUP = Number(process.env.SOAK_WARMUP || 10);
const SAMPLE_EVERY = Number(process.env.SOAK_SAMPLE_EVERY || 5);

// Per-pass growth allowances. A genuinely leaking listener adds ≥1 per pass, and
// a retained transcript clone adds hundreds of nodes per pass, so these sit well
// below any real leak while absorbing the odd node or listener that legitimately
// settles late (lazy UI, cache fills).
const NODE_LIMIT = Number(process.env.SOAK_NODE_LIMIT || 1);
const LISTENER_LIMIT = Number(process.env.SOAK_LISTENER_LIMIT || 0.5);
// Heap is reported but NOT asserted by default: JIT state, string interning and
// GC timing move it around by megabytes between runs, so a threshold tight enough
// to catch anything is loose enough to flake. Set SOAK_HEAP_LIMIT (bytes per
// pass) to turn it into an assertion when chasing a specific heap regression.
const HEAP_LIMIT = process.env.SOAK_HEAP_LIMIT ? Number(process.env.SOAK_HEAP_LIMIT) : null;

// Least-squares slope of y against x — the per-pass growth rate.
function slope(samples, key) {
  const n = samples.length;
  if (n < 2) return 0;
  const mx = samples.reduce((a, s) => a + s.pass, 0) / n;
  const my = samples.reduce((a, s) => a + s[key], 0) / n;
  const num = samples.reduce((a, s) => a + (s.pass - mx) * (s[key] - my), 0);
  const den = samples.reduce((a, s) => a + (s.pass - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

// Force a GC, then read the renderer's own counters. Nodes counts live nodes
// including detached ones still referenced from JS — which is precisely the
// retained-clone case we care about — so the GC matters: without it, garbage
// that simply hasn't been collected yet reads identically to a leak.
async function sample(cdp, pass) {
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
  return {
    pass,
    nodes: m.Nodes,
    listeners: m.JSEventListeners,
    documents: m.Documents,
    heap: m.JSHeapUsedSize,
  };
}

// One full cycle, ending where it started: transcript view.
async function togglePass(page) {
  await page.click('#caption-editor-btn');
  await page.waitForSelector('#captions-display', { timeout: 15000 });
  await page.click('#transcript-editor-btn');
  await page.waitForSelector('#hypertranscript [data-m]', { timeout: 15000 });
}

test('caption-mode toggling does not accumulate nodes or listeners', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Performance.getMetrics is Chromium-only');

  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');

  // Warm up first: the first few toggles do one-off work (caption template
  // parse, captionCache fill, lazily created UI) that would otherwise land in
  // the trend as a fake leak.
  for (let i = 0; i < WARMUP; i++) await togglePass(page);

  const samples = [await sample(cdp, 0)];
  for (let pass = 1; pass <= PASSES; pass++) {
    await togglePass(page);
    if (pass % SAMPLE_EVERY === 0) samples.push(await sample(cdp, pass));
  }

  const baseline = samples[0];
  const final = samples[samples.length - 1];
  const rates = {
    nodes: slope(samples, 'nodes'),
    listeners: slope(samples, 'listeners'),
    heap: slope(samples, 'heap'),
  };

  const report = {
    passes: PASSES,
    warmup: WARMUP,
    samples: samples.length,
    baseline,
    final,
    net: {
      nodes: final.nodes - baseline.nodes,
      listeners: final.listeners - baseline.listeners,
      documents: final.documents - baseline.documents,
      heapKB: Math.round((final.heap - baseline.heap) / 1024),
    },
    perPass: {
      nodes: +rates.nodes.toFixed(3),
      listeners: +rates.listeners.toFixed(3),
      heapBytes: Math.round(rates.heap),
    },
    limits: { nodes: NODE_LIMIT, listeners: LISTENER_LIMIT, heapBytes: HEAP_LIMIT },
    series: samples,
  };
  await test.info().attach('soak-metrics.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  console.log(
    `\ncaption-mode soak — ${PASSES} passes (+${WARMUP} warmup), ${samples.length} samples\n` +
    `  nodes     ${baseline.nodes} → ${final.nodes}  (${report.perPass.nodes}/pass, limit ${NODE_LIMIT})\n` +
    `  listeners ${baseline.listeners} → ${final.listeners}  (${report.perPass.listeners}/pass, limit ${LISTENER_LIMIT})\n` +
    `  heap      ${Math.round(baseline.heap / 1024)}KB → ${Math.round(final.heap / 1024)}KB  ` +
    `(${report.perPass.heapBytes}B/pass${HEAP_LIMIT === null ? ', not asserted' : `, limit ${HEAP_LIMIT}`})\n` +
    `  documents ${baseline.documents} → ${final.documents}\n`
  );

  // Documents is a flat-out bug check rather than a trend: a detached document
  // per pass means an iframe or DOMParser result is being retained wholesale.
  expect(final.documents - baseline.documents,
    'detached documents accumulated across toggles').toBeLessThanOrEqual(1);

  expect(rates.listeners,
    `event listeners grew ${rates.listeners.toFixed(2)}/pass — something rebinds on the ` +
    'toggle path without unbinding (see the attached soak-metrics.json series)')
    .toBeLessThanOrEqual(LISTENER_LIMIT);

  expect(rates.nodes,
    `DOM nodes grew ${rates.nodes.toFixed(2)}/pass — nodes are being retained after ` +
    'the holder is rebuilt (detached clones stay in this count until collected)')
    .toBeLessThanOrEqual(NODE_LIMIT);

  if (HEAP_LIMIT !== null) {
    expect(rates.heap,
      `JS heap grew ${Math.round(rates.heap)}B/pass`).toBeLessThanOrEqual(HEAP_LIMIT);
  }
});

/* Device benchmark for HLE's practical limits (#400 follow-up).
 *
 * Activated ONLY with ?bench=1 in the URL — invisible otherwise. Builds
 * synthetic timed transcripts at several sizes in the live editor and
 * measures, on THIS device and THIS browser:
 *
 *   - typing cost per keystroke (includes history's per-key pre-snapshot);
 *   - the sanitise pass (runs on a 1 s debounce while typing);
 *   - snapshot weight → the undo depth actually available at that size;
 *   - undo latency;
 *   - environment: engine, cores, storage quota, WebGPU/shader-f16.
 *
 * Results render in a panel and can be copied as JSON to share in an issue.
 * WARNING: running the benchmark REPLACES the open transcript (each size is a
 * new synthetic document). Run it in a fresh tab, then reload.
 */

(function () {
  'use strict';

  if (!/[?&]bench=1\b/.test(window.location.search)) return;

  const SIZES = [1000, 5000, 10000, 20000, 40000];
  const WORDS = ['the', 'quick', 'brown', 'transcript', 'editor', 'measures',
    'performance', 'limits', 'honestly', 'today'];
  const UNDO_BYTE_CAP = 48 * 1024 * 1024; // keep in sync with transcript-history.js
  const UNDO_ENTRY_CAP = 100;

  const median = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  function buildTranscript(words) {
    let html = '<article><section>';
    let m = 0;
    for (let i = 0; i < words; i += 1) {
      if (i % 60 === 0) html += (i ? '</p>' : '') + '<p>';
      const d = 250 + (i % 5) * 50;
      html += '<span data-m="' + m + '" data-d="' + d + '">' + WORDS[i % 10] + ' </span>';
      m += d;
    }
    html += '</p></section></article>';
    return html;
  }

  async function environment() {
    const env = {
      userAgent: navigator.userAgent,
      cores: navigator.hardwareConcurrency || null,
      // Present in Chromium only, capped at 8 and deliberately coarse — a hint,
      // never a measurement.
      deviceMemoryHintGB: navigator.deviceMemory || null,
      touch: navigator.maxTouchPoints > 0,
    };
    try {
      const est = await navigator.storage.estimate();
      env.storageQuotaGB = +(est.quota / 1e9).toFixed(2);
      env.storageUsedMB = +(est.usage / 1e6).toFixed(1);
    } catch (e) { env.storageQuotaGB = null; }
    try {
      const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
      env.webgpu = adapter !== null;
      env.shaderF16 = adapter !== null && adapter.features.has('shader-f16');
    } catch (e) { env.webgpu = false; env.shaderF16 = false; }
    return env;
  }

  // The library-aware path (#517 follow-up): the benchmark runs in its OWN
  // project instead of whatever the user had open. hyperaudioInit births a
  // project (that is how every engine's transcription lands), so it is
  // dispatched ONCE — for the first size — and the entry renamed 'Benchmark'.
  // Later sizes swap the transcript in place and reset history explicitly:
  // dispatching init per size would birth five junk projects per run.
  const lib = () => (window.HyperaudioSave && window.HyperaudioSave.library) || null;

  async function prepareDocument(words, first) {
    const t = document.getElementById('hypertranscript');
    const before = lib() ? lib().currentId() : null;
    t.innerHTML = buildTranscript(words);
    if (first || !window.transcriptHistory) {
      document.dispatchEvent(new CustomEvent('hyperaudioInit')); // births the Benchmark project
      if (lib()) {
        for (let i = 0; i < 30 && lib().currentId() === before; i += 1) await wait(100);
        const id = lib().currentId();
        if (id !== null && id !== before) await lib().rename(id, 'Benchmark');
      }
    } else {
      // same document: fresh history baseline + player word index, no new project
      window.transcriptHistory.reset('bench-size');
      const inst = window.hyperaudioInstance;
      if (inst && typeof inst.setupTranscriptWords === 'function') inst.setupTranscriptWords();
      t.dispatchEvent(new Event('input', { bubbles: true })); // the autosave owns this content now
    }
    await wait(200);
  }

  async function measureSize(words, first) {
    const t = document.getElementById('hypertranscript');
    await prepareDocument(words, first);

    const spans = t.querySelectorAll('span[data-m]');
    const mid = spans[Math.floor(spans.length / 2)];
    t.focus();
    window.getSelection().collapse(mid.firstChild, 2);

    const typing = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      document.execCommand('insertText', false, 'x');
      typing.push(performance.now() - t0);
      await wait(600); // outside the coalesce window → each keystroke is a full commit
    }

    const sanitise = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      if (typeof window.hyperaudioNormalizeAfterHistoryRestore === 'function') {
        window.hyperaudioNormalizeAfterHistoryRestore();
      }
      sanitise.push(performance.now() - t0);
    }

    const stats = window.transcriptHistory ? window.transcriptHistory.inspect() : null;
    const perEntry = stats && stats.length ? stats.totalBytes / stats.length : 0;

    let undoMs = null;
    if (window.transcriptHistory) {
      const u0 = performance.now();
      window.transcriptHistory.undo();
      undoMs = +(performance.now() - u0).toFixed(1);
    }

    return {
      words,
      minutesOfSpeech: Math.round(words / 150),
      typingMs: +median(typing).toFixed(1),
      sanitiseMs: +median(sanitise).toFixed(1),
      kbPerUndoEntry: Math.round(perEntry / 1024),
      effectiveUndoDepth: perEntry
        ? Math.min(UNDO_ENTRY_CAP, Math.floor(UNDO_BYTE_CAP / perEntry)) : null,
      undoMs,
    };
  }

  // One generator serves both the Copy MD button and the .md download: the
  // human-readable table the issue tables were written in, with the full JSON
  // in a fence at the bottom so a single file serves readers and scripts.
  function mdOf(report) {
    const env = report.env || {};
    const lines = [
      '## HLE limits benchmark',
      '',
      '- engine: ' + (env.userAgent || 'unknown'),
      '- cores: ' + (env.cores || '?')
        + (env.deviceMemoryHintGB ? ' · memory hint: ' + env.deviceMemoryHintGB + 'GB' : ''),
      '- storage quota: ' + (env.storageQuotaGB !== null && env.storageQuotaGB !== undefined
        ? env.storageQuotaGB + 'GB' : 'n/a'),
      '- local ASR (WebGPU shader-f16): ' + (env.shaderF16 ? 'yes' : 'no'),
      '',
      '| Speech | Words | Key (ms) | Pass (ms) | Undo depth | Undo (ms) | Verdict |',
      '|---|---|---|---|---|---|---|',
    ];
    (report.rows || []).forEach((row) => {
      lines.push('| ~' + row.minutesOfSpeech + ' min | ' + row.words
        + ' | ' + row.typingMs + ' | ' + row.sanitiseMs
        + ' | ' + row.effectiveUndoDepth + ' | ' + row.undoMs
        + ' | ' + verdict(row)[0] + ' |');
    });
    lines.push('', '<details><summary>JSON</summary>', '', '```json',
      JSON.stringify(report, null, 2), '```', '', '</details>', '');
    return lines.join('\n');
  }

  // --- panel -----------------------------------------------------------------

  function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text) node.textContent = text;
    return node;
  }

  function verdict(row) {
    if (row.typingMs <= 20 && row.sanitiseMs <= 30) return ['fluid', '#0b7a78'];
    if (row.typingMs <= 60 && row.sanitiseMs <= 120) return ['ok', '#8a7a12'];
    if (row.typingMs <= 120 && row.sanitiseMs <= 250) return ['heavy', '#b76e12'];
    return ['degraded', '#b3372b'];
  }

  const panel = el('div',
    'position:fixed;top:12px;right:12px;z-index:100000;width:340px;max-height:86vh;'
    + 'overflow:auto;background:#141d1c;color:#e7ecea;border:1px solid #2d3d3a;'
    + 'border-radius:12px;padding:14px 16px;box-shadow:0 12px 30px rgba(0,0,0,.4);'
    + 'font:12px ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.5;');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'HLE limits benchmark');

  const title = el('div', 'font-weight:700;font-size:13px;margin-bottom:2px;', 'HLE limits benchmark');
  const warn = el('div', 'color:#e0a24a;margin-bottom:8px;',
    'Runs in its own "Benchmark" project — your open project is untouched '
    + 'and restored when the run completes.');
  const envBox = el('div', 'color:#93a29f;white-space:pre-wrap;margin-bottom:8px;', 'environment: …');
  const runBtn = el('button',
    'background:#24c9c4;color:#0d1312;border:0;border-radius:7px;padding:6px 14px;'
    + 'font:700 12px inherit;cursor:pointer;margin-right:8px;', 'Run');
  const ghostBtn = (label) => el('button',
    'background:transparent;color:#93a29f;border:1px solid #2d3d3a;border-radius:7px;'
    + 'padding:6px 10px;font:12px inherit;cursor:pointer;display:none;margin-right:6px;'
    + 'margin-top:6px;', label);
  const copyBtn = ghostBtn('Copy JSON');
  const copyMdBtn = ghostBtn('Copy MD');
  const downloadBtn = ghostBtn('Download .md');
  const progress = el('div', 'margin:8px 0;color:#93a29f;', '');
  const results = el('div', 'margin-top:6px;', '');

  // Run (later 'Run again') on its own line; the three report buttons as a row
  // of their own beneath it.
  const runRow = el('div', 'margin-bottom:2px;');
  runRow.appendChild(runBtn);
  const reportRow = el('div', '');
  reportRow.append(copyBtn, copyMdBtn, downloadBtn);
  panel.append(title, warn, envBox, runRow, reportRow, progress, results);
  document.body.appendChild(panel);

  let lastReport = null;

  environment().then((env) => {
    envBox.textContent = 'cores: ' + (env.cores || '?')
      + (env.deviceMemoryHintGB ? ' · mem hint: ' + env.deviceMemoryHintGB + 'GB' : '')
      + '\nstorage quota: ' + (env.storageQuotaGB !== null ? env.storageQuotaGB + 'GB' : 'n/a')
      + '\nlocal ASR (WebGPU shader-f16): ' + (env.shaderF16 ? 'yes' : 'no');
    lastReport = { env, rows: [] };
  });

  function renderRow(row) {
    const [label, color] = verdict(row);
    const line = el('div', 'display:flex;justify-content:space-between;gap:8px;'
      + 'border-top:1px solid #22302d;padding:5px 0;');
    const left = el('div', '',
      '~' + row.minutesOfSpeech + ' min (' + (row.words / 1000) + 'k words)');
    const right = el('div', 'text-align:right;color:#93a29f;');
    right.innerHTML = 'key <b style="color:#e7ecea">' + row.typingMs + 'ms</b>'
      + ' · pass <b style="color:#e7ecea">' + row.sanitiseMs + 'ms</b>'
      + '<br>undo ×<b style="color:#e7ecea">' + row.effectiveUndoDepth + '</b>'
      + ' @ ' + row.undoMs + 'ms'
      + ' · <b style="color:' + color + '">' + label + '</b>';
    line.append(left, right);
    results.appendChild(line);
  }

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    runBtn.textContent = 'Running…';
    results.textContent = '';
    lastReport.rows = [];
    const homeId = lib() ? lib().currentId() : null;
    for (let i = 0; i < SIZES.length; i += 1) {
      progress.textContent = 'measuring ' + SIZES[i] + ' words (' + (i + 1) + '/' + SIZES.length + ')…';
      // eslint-disable-next-line no-await-in-loop
      const row = await measureSize(SIZES[i], i === 0);
      lastReport.rows.push(row);
      renderRow(row);
      // eslint-disable-next-line no-await-in-loop
      await wait(150);
    }
    if (homeId !== null && lib()) {
      await lib().open(homeId); // put the user back where they were
      progress.textContent = 'done — returned to your project. The Benchmark project is in Recents.';
    } else if (lib()) {
      progress.textContent = 'done — the Benchmark project is in Recents.';
    } else {
      progress.textContent = 'done — reload the page to leave the synthetic document.';
    }
    runBtn.textContent = 'Run again';
    runBtn.disabled = false;
    copyBtn.style.display = 'inline-block';
    copyMdBtn.style.display = 'inline-block';
    downloadBtn.style.display = 'inline-block';
  });

  // Shared by both copy buttons; the fallback textarea serves whichever text
  // was last requested.
  function copyText(text, btn, restLabel) {
    const showFallback = () => {
      // Insecure contexts (e.g. a phone hitting a LAN server over http) have no
      // clipboard API — show the JSON pre-selected for a manual copy instead.
      let area = panel.querySelector('textarea');
      if (!area) {
        area = el('textarea',
          'width:100%;height:120px;margin-top:8px;background:#101817;color:#e7ecea;'
          + 'border:1px solid #2d3d3a;border-radius:7px;font:11px inherit;padding:6px;');
        area.setAttribute('aria-label', 'Benchmark JSON');
        panel.appendChild(area);
      }
      area.value = text;
      area.focus();
      area.select();
      btn.textContent = 'Select & copy manually';
      setTimeout(() => { btn.textContent = restLabel; }, 2500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied ✓';
        setTimeout(() => { btn.textContent = restLabel; }, 1500);
      }, showFallback);
    } else {
      showFallback();
    }
  }

  copyBtn.addEventListener('click', () => {
    copyText(JSON.stringify(lastReport, null, 2), copyBtn, 'Copy JSON');
  });

  copyMdBtn.addEventListener('click', () => {
    copyText(mdOf(lastReport), copyMdBtn, 'Copy MD');
  });

  downloadBtn.addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([mdOf(lastReport)], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hle-benchmark-' + stamp + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
})();

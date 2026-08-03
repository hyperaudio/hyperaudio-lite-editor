/*
 * ============================================================================
 * TRANSCRIPT DOCUMENT EXPORTS (#467) — TXT and Markdown
 * ============================================================================
 *
 * @version 1.1.1 — last changed in release 1.1.1
 *
 * Rendered document exports of the transcript, added to the FILE →
 * Export / Import submenu. RENDERED means the semantics of the format doc's
 * § 1.1 privacy caveat (share rendered exports, not project files):
 *
 *   - struck (redacted) words are DROPPED — a redacted word must not survive
 *     into a shared document, matching the media-export semantics;
 *   - speakers come from the paragraph model and become prefixes
 *     ("Maria: …" in TXT, "**Maria:**" in Markdown);
 *   - paragraphs become paragraphs (blank-line separated).
 *
 * One shared serializer over the words/paragraphs model with a thin renderer
 * per format; the pure layer is exported for node --test. The transcript
 * comes from HyperaudioSave.getTranscriptJson(), the same speaker-preserving,
 * caption-mode-aware gather the save path uses. Export filenames come from
 * the project title, like the .hyperaudio export.
 */

(function () {
  'use strict';

  /* ==========================================================================
   * Pure renderers (node-testable)
   * ======================================================================== */

  // Assign words to paragraphs the same way the editor builds its DOM from
  // JSON: a word belongs to the paragraph whose [start, end) contains its
  // start; with no paragraphs everything is one block. Struck words are
  // dropped here so every renderer inherits the redaction semantics.
  function paragraphsWithWords(transcript) {
    const words = ((transcript && transcript.words) || []).filter((w) => w.struck !== true);
    const paragraphs = (transcript && transcript.paragraphs && transcript.paragraphs.length > 0)
      ? transcript.paragraphs
      : [{ start: -Infinity, end: Infinity, speaker: null }];
    return paragraphs
      .map((p) => ({
        speaker: p.speaker || null,
        words: words.filter((w) => w.start >= p.start && w.start < p.end),
      }))
      .filter((p) => p.words.length > 0);
  }

  // Words carry their own trailing-space flag (space: false = none), so
  // dropping struck words never leaves double spaces behind.
  function joinWords(words) {
    return words.map((w) => w.text + (w.space === false ? '' : ' ')).join('').trim();
  }

  function renderTxt(transcript) {
    const blocks = paragraphsWithWords(transcript)
      .map((p) => (p.speaker ? p.speaker + ': ' : '') + joinWords(p.words));
    return blocks.length > 0 ? blocks.join('\n\n') + '\n' : '';
  }

  // Escape the inline constructs a transcript word could accidentally
  // trigger ("*laughs*" must not italicise); full CommonMark escaping is
  // overkill for natural speech.
  function escapeMd(text) {
    return String(text).replace(/([\\`*_[\]])/g, '\\$1');
  }

  function renderMarkdown(transcript) {
    const blocks = paragraphsWithWords(transcript)
      .map((p) => {
        const text = joinWords(p.words.map((w) => ({
          text: escapeMd(w.text),
          space: w.space,
        })));
        return (p.speaker ? '**' + escapeMd(p.speaker) + ':** ' : '') + text;
      });
    return blocks.length > 0 ? blocks.join('\n\n') + '\n' : '';
  }

  /* ==========================================================================
   * Clipboard HTML (#467): the rich flavour for the copy button. Deliberately
   * conservative markup — plain <p> and <b> only — because paste targets
   * apply their own defaults, and minimal markup pastes cleanly everywhere.
   * ======================================================================== */

  function renderClipboardHtml(transcript) {
    return paragraphsWithWords(transcript)
      .map((p) => '<p>'
        + (p.speaker ? '<b>' + escapeXml(p.speaker) + ':</b> ' : '')
        + escapeXml(joinWords(p.words)) + '</p>')
      .join('\n');
  }

  /* ==========================================================================
   * DOCX (#467): a .docx is a zip of XML parts — the vendored JSZip builds
   * it, no new dependency. Three parts make a minimal valid package:
   * [Content_Types].xml, _rels/.rels, and word/document.xml with one w:p per
   * paragraph (bold run for the speaker prefix, normal run for the text).
   * Opens natively in Word, Pages, LibreOffice and Google Docs. NOT the
   * legacy binary .doc, and not the HTML-named-.doc trick.
   * ======================================================================== */

  function escapeXml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // The document part. xml:space="preserve" keeps the speaker prefix's
  // trailing space; word text is XML-escaped (it is user/file data).
  function docxDocumentXml(transcript) {
    const paragraphs = paragraphsWithWords(transcript).map((p) => {
      const runs = [];
      if (p.speaker) {
        runs.push('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">'
          + escapeXml(p.speaker + ': ') + '</w:t></w:r>');
      }
      runs.push('<w:r><w:t xml:space="preserve">' + escapeXml(joinWords(p.words)) + '</w:t></w:r>');
      return '<w:p>' + runs.join('') + '</w:p>';
    });
    if (paragraphs.length === 0) paragraphs.push('<w:p/>');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:body>' + paragraphs.join('') + '</w:body></w:document>';
  }

  const DOCX_CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';

  const DOCX_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';

  // Assemble the package (JSZip implementation injected — node-testable,
  // same pattern as the container layer in hyperaudio-save.js).
  function buildDocx(transcript, JSZipImpl, outType) {
    const zip = new JSZipImpl();
    zip.file('[Content_Types].xml', DOCX_CONTENT_TYPES);
    zip.file('_rels/.rels', DOCX_RELS);
    zip.file('word/document.xml', docxDocumentXml(transcript));
    return zip.generateAsync({ type: outType || 'uint8array', compression: 'DEFLATE' });
  }

  /* ==========================================================================
   * Exports for node --test, then browser-only code.
   * ======================================================================== */

  const pure = {
    paragraphsWithWords, joinWords, escapeMd, renderTxt, renderMarkdown,
    escapeXml, docxDocumentXml, buildDocx, renderClipboardHtml,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = pure;
  }
  if (typeof document === 'undefined') {
    return; // node context: pure layer only
  }

  /* ==========================================================================
   * UI — menu items in FILE → Export / Import, download wiring
   * ======================================================================== */

  function currentTranscript() {
    if (window.HyperaudioSave && typeof window.HyperaudioSave.getTranscriptJson === 'function') {
      return window.HyperaudioSave.getTranscriptJson();
    }
    // fallback: the live DOM keeps its speaker classes
    const el = document.querySelector('#hypertranscript');
    return el !== null && typeof htmlToJSON === 'function'
      ? htmlToJSON(el.innerHTML)
      : { words: [], paragraphs: [] };
  }

  // Same title→filename rule as the .hyperaudio export.
  function exportFilename(extension) {
    const title = ((window.HyperaudioSave && window.HyperaudioSave.getProjectTitle()) || 'transcript')
      .replace(/[\\/:*?"<>|]+/g, '-').trim() || 'transcript';
    return title + extension;
  }

  function triggerDownload(data, extension, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename(extension);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function boot() {
    // Sit directly under Export Project (.hyperaudio); this script loads
    // after hyperaudio-save.js, so its DOMContentLoaded wiring (and menu
    // injection) has already run.
    const markup =
      '<li><a id="export-transcript-txt">Transcript (.txt)</a></li>'
      + '<li><a id="export-transcript-md">Transcript (.md)</a></li>'
      + '<li><a id="export-transcript-docx">Transcript (.docx)</a></li>';
    const projectExport = document.getElementById('project-export-hyperaudio');
    if (projectExport !== null && projectExport.closest('li') !== null) {
      projectExport.closest('li').insertAdjacentHTML('afterend', markup);
    } else {
      const submenu = document.querySelector('#file-export-submenu ul');
      if (submenu === null) return;
      submenu.insertAdjacentHTML('afterbegin', markup);
    }

    document.getElementById('export-transcript-txt').addEventListener('click', () => {
      triggerDownload(renderTxt(currentTranscript()), '.txt', 'text/plain');
    });
    document.getElementById('export-transcript-md').addEventListener('click', () => {
      triggerDownload(renderMarkdown(currentTranscript()), '.md', 'text/markdown');
    });
    document.getElementById('export-transcript-docx').addEventListener('click', async () => {
      const loader = window.HyperaudioSave && window.HyperaudioSave.loadJSZip;
      if (typeof loader !== 'function') return;
      const blob = await buildDocx(currentTranscript(), await loader(), 'blob');
      triggerDownload(blob, '.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });
  }

  /* ==========================================================================
   * Copy-transcript button (#467): pinned to the transcript card's top-right
   * corner (the top toolbar is crowded on mobile and lower resolutions).
   *
   * Contract: ALWAYS copies the WHOLE rendered transcript, selection or not.
   * A selection-sensitive button is a trap (contenteditable selections
   * survive focus loss), and selection copying already has an owner — native
   * ⌘C, which must stay verbatim because it doubles as an editing operation.
   * ⌘C = editing copy, verbatim; this button = publishing copy, rendered
   * clean (struck words dropped, speaker prefixes).
   *
   * Both clipboard flavours ride one ClipboardItem — text/plain (the TXT
   * rendering) and text/html — so Docs/Word/Notion paste formatted while
   * terminals and plain editors get clean text; ⇧⌘V forces plain anywhere.
   * The strings are built synchronously in the click gesture (Safari-safe).
   * ======================================================================== */

  const COPY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const CHECK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  let copyResetTimer = null;

  async function copyTranscript(btn, statusEl) {
    const transcript = currentTranscript();
    const plain = renderTxt(transcript);
    const html = renderClipboardHtml(transcript);
    try {
      if (navigator.clipboard && typeof ClipboardItem !== 'undefined'
          && typeof navigator.clipboard.write === 'function') {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })]);
      } else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(plain); // older engines: plain only
      } else {
        return;
      }
    } catch (e) {
      console.warn('transcript-doc-export: clipboard write failed', e);
      return;
    }
    // clipboard writes are invisible — flip to a checkmark and announce
    btn.dataset.copied = '1';
    btn.innerHTML = CHECK_SVG;
    statusEl.textContent = '';
    statusEl.textContent = 'Transcript copied to clipboard.';
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      delete btn.dataset.copied;
      btn.innerHTML = COPY_SVG;
    }, 1500);
  }

  function bootCopyButton() {
    const statusEl = document.createElement('div');
    statusEl.id = 'transcript-copy-status';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(statusEl);

    const btn = document.createElement('button');
    btn.id = 'transcript-copy-btn';
    btn.type = 'button';
    btn.className = 'btn btn-square btn-ghost btn-sm tooltip';
    btn.setAttribute('data-tip', 'Copy transcript');
    btn.setAttribute('aria-label', 'Copy transcript');
    btn.innerHTML = COPY_SVG;
    btn.addEventListener('click', () => { copyTranscript(btn, statusEl); });
    document.body.appendChild(btn);

    // The caption editor owns that corner in caption mode (its Regenerate
    // button floats there), and "copy transcript" is a transcript-mode act —
    // hide/show with the view switch. The engines force transcript view by
    // clicking #transcript-editor-btn, so this covers programmatic switches.
    const captionBtn = document.getElementById('caption-editor-btn');
    const transcriptBtn = document.getElementById('transcript-editor-btn');
    if (captionBtn !== null) {
      captionBtn.addEventListener('click', () => { btn.style.display = 'none'; });
    }
    if (transcriptBtn !== null) {
      transcriptBtn.addEventListener('click', () => { btn.style.display = ''; });
    }
  }

  function bootAll() {
    boot();
    bootCopyButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAll);
  } else {
    bootAll();
  }
})();

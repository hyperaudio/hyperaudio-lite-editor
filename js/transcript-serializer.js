/**
 * transcript-serializer.js
 * (C) The Hyperaudio Project
 * @version 1.1.8 — last changed in release 1.1.8
 * @license MIT
 *
 * Canonical transcript serialization for the HTML and interactive-transcript
 * exports. The live DOM accumulates editing noise (runtime classes, WebKit
 * inline styles, arbitrary attribute order), so exports built from raw
 * innerHTML shipped that noise verbatim. This walks the transcript and emits
 * clean, consistently formatted markup instead:
 *
 *   <article>
 *     <section>
 *       <p>
 *         <span data-m="640" data-d="80">The </span>
 *         <span data-m="960" data-d="1040" class="speaker">[Monika] </span>
 *       </p>
 *     </section>
 *   </article>
 *
 * — one span per line, two-space indents, data-m before data-d, class only
 * for speaker labels, style only for strikethrough (the two functional bits
 * of state, cf. #415). Text is re-escaped from textContent, so words like
 * "<inaudible>" survive as text (#406/#409 companion).
 *
 * Loaded as a plain <script>; exposes `serializeTranscriptHtml` as a global.
 */

(function () {
  const escapeText = (t) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeAttr = (t) => escapeText(t).replace(/"/g, '&quot;');

  // One span, canonical shape: data-m, data-d, speaker class, strike style.
  function spanLine(span) {
    const m = span.getAttribute('data-m');
    const d = span.getAttribute('data-d');
    let attrs = '';
    if (m !== null) attrs += ` data-m="${escapeAttr(m)}"`;
    if (d !== null) attrs += ` data-d="${escapeAttr(d)}"`;
    if (span.classList.contains('speaker')) attrs += ' class="speaker"';
    if (((span.style && span.style.textDecoration) || '').includes('line-through')) {
      attrs += ' style="text-decoration: line-through;"';
    }
    return `<span${attrs}>${escapeText(span.textContent)}</span>`;
  }

  function serializeParagraph(p, indent) {
    const inner = indent + '  ';
    const lines = [indent + '<p>'];
    const emit = (nodes) => {
      nodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'SPAN' && node.hasAttribute('data-m')) {
          lines.push(inner + spanLine(node));
        } else if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim() !== '') {
          // stray text between spans — keep it (escaped) rather than lose words
          lines.push(inner + escapeText(node.nodeValue.trim()) + ' ');
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          // An unexpected wrapper. When it ENCLOSES timed spans, descend into it:
          // contenteditable produces these (⌘B over a selection wraps the spans
          // in <b>; paste-injected markup does the same, cf. #487), and
          // flattening them to text would strip data-m/data-d from real words —
          // and, since the writer derives the project JSON from this output,
          // delete those words outright. Only a wrapper holding no timed span of
          // its own is flattened to its text (a residual search <mark>, #486).
          if (node.querySelector('span[data-m]') !== null) {
            emit([...node.childNodes]);
          } else if (node.textContent.trim() !== '') {
            lines.push(inner + escapeText(node.textContent.trim()) + ' ');
          }
        }
      });
    };
    emit([...p.childNodes]);
    lines.push(indent + '</p>');
    return lines;
  }

  /**
   * Serialize a transcript root (the #hypertranscript element, a clone of it,
   * or an <article>) to canonical, indented HTML. Falls back to innerHTML if
   * there are no timed spans (e.g. loader markup), so callers can use it
   * unconditionally.
   */
  function serializeTranscriptHtml(root) {
    if (!root || root.querySelector === undefined) return '';
    if (root.querySelector('span[data-m]') === null) {
      return root.innerHTML || '';
    }
    const lines = ['<article>', '  <section>'];
    root.querySelectorAll('p').forEach((p) => {
      if (p.querySelector('span[data-m]') === null) return; // skip empty/UI paragraphs
      lines.push(...serializeParagraph(p, '    '));
    });
    // Timed spans belonging to no <p> at all: the whole transcript when it has
    // no paragraph structure, and otherwise words that editing parked as a
    // direct child of <section> (or inside a non-<p> wrapper there). Iterating
    // only <p> elements dropped those words from the output entirely.
    const orphans = [...root.querySelectorAll('span[data-m]')]
      .filter((span) => span.closest('p') === null);
    if (orphans.length > 0) {
      lines.push(...serializeParagraph({ childNodes: orphans }, '    '));
    }
    lines.push('  </section>', '</article>');
    return lines.join('\n');
  }

  if (typeof window !== 'undefined') {
    window.serializeTranscriptHtml = serializeTranscriptHtml;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { serializeTranscriptHtml };
  }
})();

/**
 * a11y.js
 * (C) The Hyperaudio Project
 * @version 0.8.3 — last changed in release 0.8.3
 * @license MIT
 *
 * Keyboard operability for the DaisyUI modal pattern (#402).
 *
 * Modals open/close via visually-hidden `input.modal-toggle` checkboxes driven
 * by `<label for>` buttons. The toggles are now `aria-hidden` + `tabindex=-1`
 * (they're a CSS mechanism, and were flagged as unlabeled / multiply-labelled
 * form fields), which removes what was previously the only keyboard path — an
 * invisible focused checkbox. This module makes the VISIBLE label-buttons the
 * keyboard surface instead: any `label[for]` that targets a modal-toggle gets
 * `tabindex="0"` and activates on Enter/Space, like a real button.
 *
 * A MutationObserver wires label-buttons injected after load (the import
 * dialogs render from custom-element templates; caption mode injects the
 * floating regenerate button at runtime).
 */

(function () {
  const targetsModalToggle = (label) => {
    const id = label.getAttribute('for');
    if (!id) return false;
    const target = document.getElementById(id);
    return target !== null && target.classList.contains('modal-toggle');
  };

  const wire = (root) => {
    root.querySelectorAll('label[for]:not([data-a11y-wired])').forEach((label) => {
      if (!targetsModalToggle(label)) return;
      label.dataset.a11yWired = '1';
      if (!label.hasAttribute('tabindex')) label.setAttribute('tabindex', '0');
    });
  };

  // Activate on Enter/Space, matching button behaviour (delegated so it also
  // covers labels wired after load).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const label = e.target instanceof Element ? e.target.closest('label[data-a11y-wired]') : null;
    if (label === null) return;
    e.preventDefault(); // stop Space scrolling the page
    label.click();
  });

  const init = () => {
    wire(document);
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) wire(node.parentNode || node);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

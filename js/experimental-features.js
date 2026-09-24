/**
 * experimental-features.js
 * (C) The Hyperaudio Project
 * @version 1.3.25 — last changed in release 1.3.25
 * @license MIT
 *
 * Settings ▸ Application ▸ Experimental features. Anything in the page marked
 * data-experimental is left out unless the switch is on: taken out of the
 * DOM, not hidden, because Safari shows a hidden <option> anyway. A marker
 * comment holds its place, so switching on puts it back where it was.
 *
 * An <option> that is selected when it is taken out hands its select back to
 * the select's default (the option marked selected in the markup), with a
 * change event so whoever remembers the choice records the fallback.
 *
 * The switch's own row in Settings is hidden while nothing in the page is
 * marked, so there is never a switch that does nothing; a setting already on
 * stays saved for the next experimental feature.
 *
 * Applied at DOMContentLoaded, before transcribe-prefs.js restores the saved
 * choices on the next tick, so a saved choice of an experimental option
 * survives a reload only while the switch is on. Changes are announced as
 * "hyperaudio:experimental" on document. Remove this file and every marked
 * element simply stays in the page.
 */
(function () {
  let entries = null;   // [{ el, marker }]

  function enabled() {
    const settings = window.HyperaudioSettings;
    return !!(settings && typeof settings.get === 'function' && settings.get('experimentalFeatures') === true);
  }

  function collect() {
    if (entries !== null) return;
    entries = [...document.querySelectorAll('[data-experimental]')].map((el) => {
      const marker = document.createComment(' experimental: ' + (el.id || el.value || el.tagName.toLowerCase()) + ' ');
      el.parentNode.insertBefore(marker, el);
      return { el, marker };
    });
  }

  function apply() {
    collect();
    const row = document.getElementById('setting-experimental-row');
    if (row !== null) row.style.display = entries.length === 0 ? 'none' : '';
    const on = enabled();
    entries.forEach(({ el, marker }) => {
      if (on) {
        if (!el.isConnected && marker.parentNode) marker.parentNode.insertBefore(el, marker.nextSibling);
        return;
      }
      if (!el.isConnected) return;
      const select = el.tagName === 'OPTION' ? el.closest('select') : null;
      const wasSelected = select !== null && el.selected;
      el.remove();
      if (wasSelected) {
        const fallback = [...select.options].find((o) => o.defaultSelected) || select.options[0];
        if (fallback) select.value = fallback.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    document.dispatchEvent(new CustomEvent('hyperaudio:experimental', { detail: { enabled: on } }));
  }

  window.HyperaudioExperimental = Object.freeze({ apply, enabled });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();

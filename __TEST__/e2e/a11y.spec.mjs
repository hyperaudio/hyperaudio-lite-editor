// Accessibility regression net for the Lighthouse findings fixed in #402:
// missing form labels, ARIA tab roles on incompatible elements, multiply-
// labelled modal toggles, and Recents contrast. Runs axe-core (the same engine
// behind Lighthouse's a11y audits) against the live editor — default view and
// the transcribe/export modals — asserting the specific rules from the issue,
// plus aria-hidden-focus (the modal toggles are aria-hidden and MUST stay out
// of the tab order for that to be valid).
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

// The rules #402 is about — scoped so unrelated/pre-existing audits don't make
// this spec flaky. Grow the list as more of the issue is addressed.
const RULES = [
  'label',                       // form elements have labels
  'select-name',                 // selects have accessible names
  'aria-required-children',      // tablist must contain tabs (roles now removed)
  'aria-allowed-role',           // no role="tab" on input/label
  'form-field-multiple-labels',  // modal toggles no longer multiply-labelled
  'color-contrast',              // Recents list legibility
  'aria-hidden-focus',           // aria-hidden toggles must be unfocusable
];

const runAxe = async (page, scope) => {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async ({ scope, rules }) => {
    const result = await window.axe.run(scope || document, {
      runOnly: { type: 'rule', values: rules },
    });
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
    }));
  }, { scope, rules: RULES });
};

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('default view (with Recents content) has no #402-class violations', async ({ page }) => {
  // populate the Recents list both ways storage.js renders it
  await page.evaluate(() => {
    const fp = document.getElementById('file-picker');
    fp.insertAdjacentHTML('beforeend', `<li><a class="file-item" title="t" data-index=0>my-project</a></li>`);
    fp.insertAdjacentHTML('beforeend', `<li style="padding:8px 16px; opacity:0.75">No files saved.</li>`);
  });
  expect(await runAxe(page)).toEqual([]);
});

test('transcribe modal (Local and Cloud tabs) has no #402-class violations', async ({ page }) => {
  await page.evaluate(() => { document.getElementById('transcribe-modal').checked = true; });
  expect(await runAxe(page, '.modal-box')).toEqual([]);
  await page.click('label[for="service-cloud"]');
  expect(await page.evaluate(async () => {
    const result = await window.axe.run(document.querySelector('#cloud-group'), {
      runOnly: { type: 'rule', values: ['label', 'select-name', 'aria-allowed-role', 'aria-required-children'] },
    });
    return result.violations.map((v) => v.id);
  })).toEqual([]);
});

test('modal label-buttons are keyboard-operable; toggles are out of the tab order', async ({ page }) => {
  const r = await page.evaluate(() => {
    const infoBtn = document.getElementById('info-btn');
    const toggle = document.getElementById('info-modal');
    return {
      btnTabbable: infoBtn.tabIndex === 0,
      btnWired: infoBtn.dataset.a11yWired === '1',
      toggleHidden: toggle.getAttribute('aria-hidden') === 'true',
      toggleUntabbable: toggle.tabIndex === -1,
    };
  });
  expect(r).toEqual({ btnTabbable: true, btnWired: true, toggleHidden: true, toggleUntabbable: true });

  // Enter on the focused label-button opens the modal (was impossible before —
  // labels aren't natively keyboard-activatable)
  await page.focus('#info-btn');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.getElementById('info-modal').checked)).toBe(true);
});

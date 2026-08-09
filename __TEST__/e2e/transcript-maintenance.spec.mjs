import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript span[data-m]');
  await page.evaluate(() => {
    // Consume the initial canonicalisation so every assertion starts with a
    // clean queue and can count only the work triggered by the test.
    window.transcriptMaintenance.flush('test-ready', { force: true });
  });
});

test('transcript inputs collapse into one delayed sanitise pass', async ({ page }) => {
  const before = await page.evaluate(() => {
    const transcript = document.getElementById('hypertranscript');
    for (let i = 0; i < 3; i += 1) {
      transcript.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: 'x',
      }));
      document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'x' }));
    }
    return window.transcriptMaintenance.inspect();
  });

  expect(before.dirty).toBe(true);
  expect(before.pending).toBe(true);
  await page.waitForTimeout(1150);
  const after = await page.evaluate(() => window.transcriptMaintenance.inspect());
  expect(after.runCount).toBe(before.runCount + 1);
  expect(after.dirty).toBe(false);
  expect(after.pending).toBe(false);
});

test('unrelated key activity cannot create transcript maintenance work', async ({ page }) => {
  const before = await page.evaluate(() => window.transcriptMaintenance.inspect().runCount);
  await page.locator('#search-box').focus();
  await page.keyboard.press('Shift');
  await page.waitForTimeout(1150);
  const after = await page.evaluate(() => window.transcriptMaintenance.inspect());

  expect(after.runCount).toBe(before);
  expect(after.dirty).toBe(false);
  expect(after.pending).toBe(false);
});

test('blur is a barrier and cancels the delayed duplicate', async ({ page }) => {
  const state = await page.evaluate(() => {
    const transcript = document.getElementById('hypertranscript');
    transcript.focus();
    transcript.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: 'x',
    }));
    const queued = window.transcriptMaintenance.inspect();
    transcript.dispatchEvent(new FocusEvent('blur'));
    return { queued, flushed: window.transcriptMaintenance.inspect() };
  });

  expect(state.queued.pending).toBe(true);
  expect(state.flushed.runCount).toBe(state.queued.runCount + 1);
  expect(state.flushed.lastReason).toBe('sanitise-blur');
  expect(state.flushed.pending).toBe(false);
  await page.waitForTimeout(1150);
  expect(await page.evaluate(() => window.transcriptMaintenance.inspect().runCount))
    .toBe(state.flushed.runCount);
});

test('a real content edit sanitises only its paragraph, then settles globally', async ({ page }) => {
  const result = await page.evaluate(() => {
    const transcript = document.getElementById('hypertranscript');
    const paragraphs = transcript.querySelectorAll('p');
    const localWord = paragraphs[0].querySelector('span[data-m]:not(.speaker)');
    const distantWord = paragraphs[1].querySelector('span[data-m]:not(.speaker)');
    const hrefBefore = document.getElementById('download-html').getAttribute('href');

    transcript.focus();
    localWord.firstChild.nodeValue = 'two words ';
    transcript.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: 'x',
    }));
    // This second mutation is intentionally not announced by an input event:
    // it proves that the already-captured local scope cannot sweep a distant p.
    distantWord.style.fontSize = '19px';
    window.hyperaudioFlushTranscriptMaintenance('test-local');
    const afterLocal = window.hyperaudioInspectTranscriptMaintenance();
    const hrefAfterLocal = document.getElementById('download-html').getAttribute('href');

    window.transcriptReconciliation.flush('sanitise-settle');
    const afterGlobal = window.hyperaudioInspectTranscriptMaintenance();
    return {
      distantStyleAfterGlobal: distantWord.style.fontSize,
      hrefStayedDeferred: hrefAfterLocal === hrefBefore,
      hrefRefreshed: document.getElementById('download-html').getAttribute('href') !== hrefBefore,
      afterLocal,
      afterGlobal,
    };
  });

  expect(result.afterLocal.lastMode).toBe('local');
  expect(result.afterLocal.lastScopeCount).toBe(1);
  expect(result.afterLocal.reconciliation.dirty).toBe(true);
  expect(result.hrefStayedDeferred).toBe(true);
  expect(result.hrefRefreshed).toBe(true);
  expect(result.distantStyleAfterGlobal).toBe('');
  expect(result.afterGlobal.lastMode).toBe('global');
  expect(result.afterGlobal.reconciliation.dirty).toBe(false);
});

test('a structural edit falls back to global maintenance', async ({ page }) => {
  const state = await page.evaluate(() => {
    const transcript = document.getElementById('hypertranscript');
    const section = transcript.querySelector('section');
    const paragraph = document.createElement('p');
    paragraph.innerHTML = '<span data-m="999999" data-d="100">added </span>';
    section.appendChild(paragraph);
    transcript.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertParagraph',
    }));
    window.hyperaudioFlushTranscriptMaintenance('test-structural');
    return window.hyperaudioInspectTranscriptMaintenance();
  });

  expect(state.lastMode).toBe('global');
  expect(state.lastScopeCount).toBe(0);
  expect(state.reconciliation.dirty).toBe(false);
});

test('a clean local pass skips whole-document history capture', async ({ page }) => {
  const transaction = await page.evaluate(() => {
    let seen = null;
    const off = transcriptGateway.onBeforeMutate((tx) => {
      if (tx.origin === 'sanitise-local') {
        seen = { origin: tx.origin, captureHistory: tx.captureHistory };
      }
    });
    const paragraph = document.querySelector('#hypertranscript p');
    window.hyperaudioRequestTranscriptMaintenance(paragraph, 'test-clean', {
      reconcile: false,
    });
    window.hyperaudioFlushTranscriptMaintenance('test-clean');
    off();
    return seen;
  });

  expect(transaction).toEqual({
    origin: 'sanitise-local',
    captureHistory: false,
  });
});

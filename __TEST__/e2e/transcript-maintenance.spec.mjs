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
  // the boot restore replaces the transcript element; edit the one that stays
  await page.waitForFunction(() => window.HyperaudioSave && window.HyperaudioSave.library.currentId() !== null);
  const result = await page.evaluate(() => {
    const transcript = document.getElementById('hypertranscript');
    const paragraphs = transcript.querySelectorAll('p');
    const localWord = paragraphs[0].querySelector('span[data-m]:not(.speaker)');
    const distantWord = paragraphs[1].querySelector('span[data-m]:not(.speaker)');
    // the HTML download link is built on demand (#734): ask for it as a click would
    const link = document.getElementById('download-html');
    const linkHref = () => { link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return link.getAttribute('href'); };
    const hrefBefore = linkHref();

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
    const hrefAfterLocal = linkHref();

    window.transcriptReconciliation.flush('sanitise-settle');
    const afterGlobal = window.hyperaudioInspectTranscriptMaintenance();
    return {
      distantStyleAfterGlobal: distantWord.style.fontSize,
      hrefFollowsTheEdit: hrefAfterLocal !== hrefBefore && decodeURIComponent(hrefAfterLocal).includes('two words'),
      hrefRefreshed: linkHref() !== hrefBefore,
      afterLocal,
      afterGlobal,
    };
  });

  expect(result.afterLocal.lastMode).toBe('local');
  expect(result.afterLocal.lastScopeCount).toBe(1);
  expect(result.afterLocal.reconciliation.dirty).toBe(true);
  expect(result.hrefFollowsTheEdit).toBe(true);
  expect(result.hrefRefreshed).toBe(true);
  expect(result.distantStyleAfterGlobal).toBe('');
  expect(result.afterGlobal.lastMode).toBe('global');
  expect(result.afterGlobal.reconciliation.dirty).toBe(false);
});

test('real keyboard input retains its paragraph scope across observer delivery', async ({ page }) => {
  await page.evaluate(() => {
    const root = document.getElementById('hypertranscript');
    const text = root.querySelector('span[data-m]:not(.speaker)').firstChild;
    root.focus();
    getSelection().setBaseAndExtent(text, 1, text, 1);
  });
  await page.keyboard.insertText('x');

  const result = await page.evaluate(() => {
    const queued = window.hyperaudioInspectTranscriptMaintenance();
    window.hyperaudioFlushTranscriptMaintenance('test-native-local');
    return { queued, flushed: window.hyperaudioInspectTranscriptMaintenance() };
  });

  expect(result.queued.pendingGlobal).toBe(false);
  expect(result.queued.dirtyScopes).toBe(1);
  expect(result.flushed.lastMode).toBe('local');
  expect(result.flushed.lastScopeCount).toBe(1);
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

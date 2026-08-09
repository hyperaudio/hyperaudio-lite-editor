import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript span[data-m]');
});

test('outer transaction owns nesting, returns values, and clears state after errors', async ({ page }) => {
  const result = await page.evaluate(() => {
    const before = [];
    const after = [];
    const offBefore = transcriptGateway.onBeforeMutate((tx) => before.push(tx.origin));
    const offAfter = transcriptGateway.onAfterMutate((tx) => after.push({
      origin: tx.origin,
      failed: tx.error !== null,
    }));

    const value = transcriptGateway.mutate(() => transcriptGateway.mutate(
      () => 42,
      { origin: 'inner' },
    ), { origin: 'outer' });
    let message = null;
    try {
      transcriptGateway.mutate(() => { throw new Error('boom'); }, { origin: 'failure' });
    } catch (error) {
      message = error.message;
    }
    offBefore();
    offAfter();
    return {
      value,
      message,
      before,
      after,
      isMutating: transcriptGateway.isMutating,
      current: transcriptGateway.currentTransaction,
    };
  });

  expect(result).toEqual({
    value: 42,
    message: 'boom',
    before: ['outer', 'failure'],
    after: [
      { origin: 'outer', failed: false },
      { origin: 'failure', failed: true },
    ],
    isMutating: false,
    current: null,
  });
});

test('blur flushes queued sanitise through the gateway without a delayed duplicate', async ({ page }) => {
  const origins = await page.evaluate(async () => {
    const seen = [];
    const off = transcriptGateway.onBeforeMutate((tx) => seen.push(tx.origin));
    const transcript = document.getElementById('hypertranscript');
    const span = transcript.querySelector('span[data-m]:not(.speaker)');
    span.textContent = 'two words ';
    transcript.focus();
    transcript.dispatchEvent(new FocusEvent('blur'));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    off();
    return seen;
  });

  expect(origins.filter((origin) => /sanitise/.test(origin))).toEqual(['sanitise-blur']);
});

test('Replace One, Replace All, and strike have explicit transaction origins', async ({ page }) => {
  const result = await page.evaluate(() => {
    const origins = [];
    transcriptGateway.onBeforeMutate((tx) => origins.push(tx.origin));

    const searchBox = document.getElementById('search-box');
    const replaceBox = document.getElementById('replace-box');
    document.getElementById('find-replace-toggle').click();
    searchBox.value = 'captions';
    searchBox.dispatchEvent(new KeyboardEvent('keyup'));
    replaceBox.value = 'subtitles';
    document.getElementById('replace-one').click();

    searchBox.value = 'the';
    searchBox.dispatchEvent(new KeyboardEvent('keyup'));
    replaceBox.value = 'THE';
    document.getElementById('replace-all').click();

    const words = document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)');
    const range = document.createRange();
    range.selectNodeContents(words[0]);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.getElementById('strikethrough').click();

    return {
      origins,
      struck: words[0].style.textDecoration.includes('line-through'),
    };
  });

  expect(result.origins).toEqual(expect.arrayContaining([
    'replace-one', 'replace-all', 'strike',
  ]));
  expect(result.struck).toBe(true);
});

test('opt-in audit distinguishes gateway, native, view, and bypass mutations', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const transcript = document.getElementById('hypertranscript');
    const first = transcript.querySelector('span[data-m]:not(.speaker)');
    transcriptGateway.audit.start(transcript);

    transcriptGateway.mutate(() => {
      first.setAttribute('data-d', String((parseInt(first.dataset.d, 10) || 0) + 1));
    }, { origin: 'test-gateway' });

    first.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      inputType: 'insertText',
      data: 'x',
    }));
    first.firstChild.nodeValue += 'x';
    first.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: 'x',
    }));

    const searchBox = document.getElementById('search-box');
    searchBox.value = 'captions';
    searchBox.dispatchEvent(new KeyboardEvent('keyup'));
    await Promise.resolve();
    await Promise.resolve();

    first.setAttribute('data-m', String((parseInt(first.dataset.m, 10) || 0) + 1));
    await Promise.resolve();
    await Promise.resolve();

    const entries = transcriptGateway.audit.stop();
    return {
      classifications: entries.map((entry) => entry.classification),
      origins: entries.map((entry) => entry.origin),
      violations: entries.filter((entry) => entry.classification === 'unclassified'),
    };
  });

  expect(result.classifications).toContain('gateway');
  expect(result.classifications).toContain('native');
  expect(result.classifications).toContain('view');
  expect(result.origins).toContain('test-gateway');
  expect(result.origins).toContain('search');
  expect(result.violations).toHaveLength(1);
  expect(result.violations[0].record).toMatchObject({
    type: 'attributes',
    attributeName: 'data-m',
  });
});

test('restore guard is nest-safe and suppresses mutation transactions', async ({ page }) => {
  const result = await page.evaluate(() => {
    const origins = [];
    transcriptGateway.onBeforeMutate((tx) => origins.push(tx.origin));
    const value = transcriptGateway.restoring(() => transcriptGateway.restoring(() => (
      transcriptGateway.mutate(() => 7, { origin: 'ignored-during-restore' })
    )));
    return {
      value,
      origins,
      isRestoring: transcriptGateway.isRestoring,
    };
  });

  expect(result).toEqual({ value: 7, origins: [], isRestoring: false });
});

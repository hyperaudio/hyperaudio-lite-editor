import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript span[data-m]');
});

test('identity and restore are distinct monotonic lifecycle signals', async ({ page }) => {
  const result = await page.evaluate(() => {
    const identities = [];
    const restores = [];
    document.addEventListener('hyperaudioDocumentIdentityChanged', (event) => {
      identities.push(event.detail);
    });
    document.addEventListener('hyperaudioTranscriptRestored', (event) => {
      restores.push(event.detail);
    });

    const lifecycle = window.transcriptLifecycle;
    const initial = lifecycle.generation();
    lifecycle.signalIdentity('test-document');
    lifecycle.signalRestored('undo');
    lifecycle.signalRestored('redo');

    return {
      initial,
      final: lifecycle.generation(),
      identities,
      restores,
      audit: lifecycle.auditLog().slice(-3),
    };
  });

  expect(result.final).toBe(result.initial + 1);
  expect(result.identities).toHaveLength(1);
  expect(result.identities[0]).toMatchObject({
    generation: result.final,
    origin: 'test-document',
  });
  expect(result.restores).toEqual([
    { generation: result.final, origin: 'undo' },
    { generation: result.final, origin: 'redo' },
  ]);
  expect(result.audit.map((entry) => entry.type)).toEqual([
    'identity', 'restore', 'restore',
  ]);
});

test('hyperaudioInit commits one public identity signal through the save lifecycle', async ({ page }) => {
  const detail = await page.evaluate(() => new Promise((resolve) => {
    document.addEventListener('hyperaudioDocumentIdentityChanged', (event) => {
      resolve(event.detail);
    }, { once: true });
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
  }));

  expect(detail).toMatchObject({
    generation: 1,
    origin: 'transcription-or-import',
  });
  expect(await page.evaluate(() => window.transcriptLifecycle.generation())).toBe(1);
});

test('restore invalidates find references without changing identity', async ({ page }) => {
  await page.evaluate(() => {
    const searchBox = document.getElementById('search-box');
    searchBox.value = 'captions';
    searchBox.dispatchEvent(new KeyboardEvent('keyup'));
  });
  await expect(page.locator('#hypertranscript mark.search-mark')).not.toHaveCount(0);

  await page.evaluate(() => {
    const transcript = document.getElementById('hypertranscript');
    transcript.querySelectorAll('mark.search-mark').forEach((mark) => {
      mark.replaceWith(...mark.childNodes);
    });
    window.transcriptLifecycle.signalRestored('undo');
  });

  await expect(page.locator('#find-match-count')).toHaveText('0 / 0');
  await expect(page.locator('#hypertranscript mark.search-mark')).toHaveCount(0);
  expect(await page.evaluate(() => window.transcriptLifecycle.generation())).toBe(0);
});

test('identity remains unconditional while restore rejects loader markup', async ({ page }) => {
  const result = await page.evaluate(() => {
    const lifecycle = window.transcriptLifecycle;
    const transcript = document.getElementById('hypertranscript');
    const original = transcript.innerHTML;
    const before = lifecycle.generation();
    transcript.innerHTML = '<div class="transcribing-msg">Working...</div>';
    const identityAccepted = lifecycle.signalIdentity('loader');
    const restoreAccepted = lifecycle.signalRestored('undo');
    transcript.innerHTML = original;
    return {
      before,
      after: lifecycle.generation(),
      identityAccepted,
      restoreAccepted,
    };
  });

  expect(result).toEqual({
    before: 0,
    after: 1,
    identityAccepted: true,
    restoreAccepted: false,
  });
});

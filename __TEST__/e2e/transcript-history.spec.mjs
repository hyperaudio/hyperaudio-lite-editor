import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript span[data-m]');
  await page.evaluate(() => transcriptHistory.reset('test'));
});

async function nativeEdit(page, inputType = 'insertText') {
  await page.evaluate((type) => {
    const word = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    word.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: type }));
    word.firstChild.nodeValue += 'x';
    word.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: type }));
  }, inputType);
}

test('native typing coalesces and structural input forces a boundary', async ({ page }) => {
  await nativeEdit(page);
  await nativeEdit(page);
  expect(await page.evaluate(() => transcriptHistory.inspect())).toMatchObject({ length: 2, position: 1 });
  await nativeEdit(page, 'insertParagraph');
  expect(await page.evaluate(() => transcriptHistory.inspect())).toMatchObject({ length: 3, position: 2 });
});

test('real keyboard input reuses the current before snapshot and remains undoable', async ({ page }) => {
  const before = await page.evaluate(() => {
    const root = document.getElementById('hypertranscript');
    const text = root.querySelector('span[data-m]:not(.speaker)').firstChild;
    root.focus();
    getSelection().setBaseAndExtent(text, 1, text, 1);
    return {
      text: text.nodeValue,
      history: transcriptHistory.inspect(),
    };
  });

  await page.keyboard.insertText('x');
  const after = await page.evaluate(() => transcriptHistory.inspect());
  expect(after.paragraphSnapshotCount).toBe(before.history.paragraphSnapshotCount + 1);
  expect(after.fullSnapshotCount).toBe(before.history.fullSnapshotCount);
  expect(after).toMatchObject({ localEntries: 1, fullEntries: 1 });
  expect(await page.evaluate(() => transcriptHistory.undo())).toBe(true);
  expect(await page.locator('#hypertranscript span[data-m]:not(.speaker)').first().textContent())
    .toBe(before.text);
  expect(await page.evaluate(() => transcriptHistory.redo())).toBe(true);
});

test('local and full entries undo in order without losing either state', async ({ page }) => {
  const original = await page.evaluate(() => {
    const root = document.getElementById('hypertranscript');
    const words = root.querySelectorAll('span[data-m]:not(.speaker)');
    root.focus();
    getSelection().setBaseAndExtent(words[0].firstChild, 1, words[0].firstChild, 1);
    return {
      text: words[0].textContent,
      duration: words[1].getAttribute('data-d'),
    };
  });
  await page.keyboard.insertText('A');
  await page.evaluate(() => {
    const word = document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')[1];
    transcriptGateway.mutate(() => word.setAttribute('data-d', '9876'), { origin: 'mixed-full' });
    const first = document.querySelector('#hypertranscript span[data-m]:not(.speaker)').firstChild;
    getSelection().setBaseAndExtent(first, 2, first, 2);
  });
  await page.keyboard.insertText('B');

  expect(await page.evaluate(() => transcriptHistory.inspect())).toMatchObject({
    length: 4, localEntries: 2, fullEntries: 2,
  });
  await page.evaluate(() => transcriptHistory.undo());
  expect(await page.evaluate(() => ({
    text: document.querySelector('#hypertranscript span[data-m]:not(.speaker)').textContent,
    duration: document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')[1]
      .getAttribute('data-d'),
  }))).toEqual({
    text: original.text.slice(0, 1) + 'A' + original.text.slice(1),
    duration: '9876',
  });
  await page.evaluate(() => transcriptHistory.undo());
  expect(await page.evaluate(() => ({
    text: document.querySelector('#hypertranscript span[data-m]:not(.speaker)').textContent,
    duration: document.querySelectorAll('#hypertranscript span[data-m]:not(.speaker)')[1]
      .getAttribute('data-d'),
  }))).toEqual({
    text: original.text.slice(0, 1) + 'A' + original.text.slice(1),
    duration: original.duration,
  });
  await page.evaluate(() => transcriptHistory.undo());
  expect(await page.locator('#hypertranscript span[data-m]:not(.speaker)').first().textContent())
    .toBe(original.text);
});

test('local history pruning leaves a full undoable checkpoint', async ({ page }) => {
  const state = await page.evaluate(() => {
    const root = document.getElementById('hypertranscript');
    for (let index = 0; index < 120; index += 1) {
      const word = root.querySelectorAll('p')[1]
        .querySelector('span[data-m]:not(.speaker)');
      const text = word.firstChild;
      root.focus();
      getSelection().setBaseAndExtent(text, text.length, text, text.length);
      word.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, inputType: 'insertText', data: 'x',
      }));
      text.nodeValue += 'x';
      word.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: 'x',
      }));
      word.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    }
    return transcriptHistory.inspect();
  });

  expect(state).toMatchObject({
    length: 100, position: 99, fullEntries: 1, localEntries: 99,
  });
  const checkpointCaret = await page.evaluate(() => {
    const selectionOffset = () => {
      const root = document.getElementById('hypertranscript');
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(root);
      range.setEnd(selection.anchorNode, selection.anchorOffset);
      return range.toString().length;
    };
    while (transcriptHistory.inspect().position > 0) transcriptHistory.undo();
    let word = document.querySelectorAll('#hypertranscript p')[1]
      .querySelector('span[data-m]:not(.speaker)');
    const beforeFallback = selectionOffset();
    word.setAttribute('data-d', '779');
    word.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'formatBold' }));
    transcriptHistory.undo();
    return {
      position: transcriptHistory.inspect().position,
      beforeFallback,
      afterFallback: selectionOffset(),
    };
  });
  expect(checkpointCaret.position).toBe(0);
  expect(checkpointCaret.afterFallback).toBe(checkpointCaret.beforeFallback);
});

test('semantic normalization folds into current without clearing redo', async ({ page }) => {
  const result = await page.evaluate(() => {
    let word = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    transcriptGateway.mutate(() => { word.textContent += 'A'; }, { origin: 'first' });
    transcriptGateway.mutate(() => { word.textContent += 'B'; }, { origin: 'second' });
    transcriptHistory.undo();
    word = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    const beforeFold = transcriptHistory.inspect();
    transcriptGateway.mutate(() => { word.setAttribute('data-d', '777'); }, {
      origin: 'test-normalize', foldPolicy: 'normalization',
    });
    const afterFold = transcriptHistory.inspect();
    const redo = transcriptHistory.redo();
    return { beforeFold, afterFold, redo };
  });
  expect(result.beforeFold).toMatchObject({ length: 3, position: 1 });
  expect(result.afterFold).toMatchObject({ length: 3, position: 1 });
  expect(result.redo).toBe(true);
});

test('normalization fold promotes a local caret to transcript coordinates', async ({ page }) => {
  const target = await page.evaluate(() => {
    const root = document.getElementById('hypertranscript');
    const paragraph = root.querySelectorAll('p')[1];
    const word = paragraph.querySelector('span[data-m]:not(.speaker)');
    root.focus();
    getSelection().setBaseAndExtent(word.firstChild, 1, word.firstChild, 1);
    return word.textContent;
  });

  await page.keyboard.insertText('X');
  await page.evaluate(() => {
    const word = document.querySelectorAll('#hypertranscript p')[1]
      .querySelector('span[data-m]:not(.speaker)');
    transcriptGateway.mutate(() => word.setAttribute('data-d', '777'), {
      origin: 'test-local-normalize', foldPolicy: 'normalization',
    });
    transcriptHistory.undo();
  });

  const restored = await page.evaluate(() => {
    const paragraph = document.querySelectorAll('#hypertranscript p')[1];
    const word = paragraph.querySelector('span[data-m]:not(.speaker)');
    const selection = getSelection();
    return {
      text: word.textContent,
      inTargetWord: selection.anchorNode === word.firstChild,
      offset: selection.anchorOffset,
    };
  });
  expect(restored).toEqual({ text: target, inTargetWord: true, offset: 1 });
});

test('full fallback promotes the current local caret to transcript coordinates', async ({ page }) => {
  await page.evaluate(() => {
    const root = document.getElementById('hypertranscript');
    const paragraph = root.querySelectorAll('p')[1];
    const word = paragraph.querySelector('span[data-m]:not(.speaker)');
    root.focus();
    getSelection().setBaseAndExtent(word.firstChild, 1, word.firstChild, 1);
  });
  await page.keyboard.insertText('X');
  await page.evaluate(() => {
    const word = document.querySelectorAll('#hypertranscript p')[1]
      .querySelector('span[data-m]:not(.speaker)');
    word.setAttribute('data-d', '778');
    word.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'formatBold' }));
    transcriptHistory.undo();
  });

  const restored = await page.evaluate(() => {
    const word = document.querySelectorAll('#hypertranscript p')[1]
      .querySelector('span[data-m]:not(.speaker)');
    const selection = getSelection();
    return {
      inTargetWord: selection.anchorNode === word.firstChild,
      offset: selection.anchorOffset,
    };
  });
  expect(restored).toEqual({ inTargetWord: true, offset: 2 });
});

test('keydown fallback and keydown-beforeinput execute exactly once', async ({ page, browserName }) => {
  const result = await page.evaluate(async () => {
    const root = document.getElementById('hypertranscript');
    const word = root.querySelector('span[data-m]:not(.speaker)');
    root.focus();
    transcriptGateway.mutate(() => { word.textContent += '1'; }, { origin: 'one' });
    transcriptGateway.mutate(() => { word.textContent += '2'; }, { origin: 'two' });
    root.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'z', ctrlKey: true }));
    root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'historyUndo' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const paired = transcriptHistory.inspect().position;
    root.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'z', ctrlKey: true, shiftKey: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { paired, fallback: transcriptHistory.inspect().position };
  });
  expect(result, browserName).toEqual({ paired: 1, fallback: 2 });
});

test('real platform shortcut performs one step', async ({ page }) => {
  await page.evaluate(() => {
    const root = document.getElementById('hypertranscript');
    const word = root.querySelector('span[data-m]:not(.speaker)');
    root.focus();
    transcriptGateway.mutate(() => { word.textContent += '1'; }, { origin: 'one' });
    transcriptGateway.mutate(() => { word.textContent += '2'; }, { origin: 'two' });
  });
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(20);
  expect(await page.evaluate(() => transcriptHistory.inspect().position)).toBe(1);
});

test('undo preserves backward selection and identity generation', async ({ page }) => {
  const result = await page.evaluate(() => {
    const root = document.getElementById('hypertranscript');
    const text = root.querySelector('span[data-m]:not(.speaker)').firstChild;
    root.focus();
    getSelection().setBaseAndExtent(text, Math.min(4, text.length), text, 1);
    const generation = transcriptLifecycle.generation();
    transcriptGateway.mutate(() => { text.nodeValue += 'changed'; }, { origin: 'selection-test' });
    transcriptHistory.undo();
    return {
      generation,
      finalGeneration: transcriptLifecycle.generation(),
      anchor: getSelection().anchorOffset,
      focus: getSelection().focusOffset,
    };
  });
  expect(result.finalGeneration).toBe(result.generation);
  expect({ anchor: result.anchor, focus: result.focus }).toEqual({ anchor: 4, focus: 1 });
});

test('IME composition becomes one history step', async ({ page }) => {
  const state = await page.evaluate(async () => {
    const word = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    word.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    word.firstChild.nodeValue += '日本';
    word.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
    word.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
    word.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    return transcriptHistory.inspect();
  });
  expect(state).toMatchObject({ length: 2, position: 1 });
});

test('untimed identity clears stale history', async ({ page }) => {
  const result = await page.evaluate(() => {
    const root = document.getElementById('hypertranscript');
    const word = root.querySelector('span[data-m]:not(.speaker)');
    transcriptGateway.mutate(() => { word.textContent += 'old'; }, { origin: 'old-edit' });
    root.innerHTML = '<p>An empty untimed document</p>';
    return { accepted: transcriptLifecycle.signalIdentity('empty'), state: transcriptHistory.inspect() };
  });
  expect(result.accepted).toBe(true);
  expect(result.state).toMatchObject({ length: 0, position: -1 });
});

test('history is bounded while retaining an undoable baseline', async ({ page }) => {
  const state = await page.evaluate(() => {
    for (let index = 0; index < 120; index += 1) {
      const word = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
      transcriptGateway.mutate(() => { word.setAttribute('data-d', String(1000 + index)); }, {
        origin: `bounded-${index}`,
      });
    }
    return transcriptHistory.inspect();
  });
  expect(state.length).toBeLessThanOrEqual(100);
  expect(state.position).toBe(state.length - 1);
  expect(await page.evaluate(() => transcriptHistory.undo())).toBe(true);
});

test('caption mode is a no-op and the controls stay unique and accessible', async ({ page }) => {
  await page.evaluate(() => {
    const word = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
    transcriptGateway.mutate(() => { word.textContent += 'step'; }, { origin: 'step' });
  });
  await page.click('#caption-editor-btn');
  expect(await page.evaluate(() => transcriptHistory.undo())).toBe(false);
  await expect(page.locator('#transcript-undo')).toBeDisabled();
  await page.click('#transcript-editor-btn');
  await expect(page.locator('#transcript-undo')).toBeEnabled();
  await expect(page.locator('#transcript-undo')).toHaveCount(1);
  await expect(page.locator('#transcript-redo')).toHaveCount(1);
  await expect(page.locator('#transcript-undo')).toHaveAttribute('aria-label', 'Undo transcript edit');
});

// The ↶/↷ buttons became touch-only when they left the top bar for the
// transcript card's corner (the ⓘ/copy pattern) — on fine-pointer devices
// they are display:none and ⌘Z owns undo. Clicking them therefore needs a
// touch-emulated context; the default (fine-pointer) context above can still
// assert existence, aria and disabled state, which ignore visibility.
test.describe('touch devices', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the corner undo button undoes and returns focus to the transcript', async ({ page }) => {
    await page.evaluate(() => {
      const word = document.querySelector('#hypertranscript span[data-m]:not(.speaker)');
      transcriptGateway.mutate(() => { word.textContent += 'step'; }, { origin: 'step' });
    });
    await expect(page.locator('#transcript-undo')).toBeVisible();
    await page.click('#transcript-undo');
    expect(await page.evaluate(() => document.activeElement.id)).toBe('hypertranscript');
    expect(await page.evaluate(() => transcriptHistory.canRedo())).toBe(true);
  });
});

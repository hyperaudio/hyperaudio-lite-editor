import { test, expect } from '@playwright/test';

test('bench is inert without the flag', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript span[data-m]');
  await expect(page.locator('[aria-label="HLE limits benchmark"]')).toHaveCount(0);
});

test('bench panel appears with ?bench=1 and produces measurements', async ({ page }) => {
  test.setTimeout(240000);
  await page.goto('/index.html?bench=1');
  await page.waitForSelector('#hypertranscript span[data-m]');
  const panel = page.locator('[aria-label="HLE limits benchmark"]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('local ASR');
  await panel.getByRole('button', { name: 'Run' }).click();
  await expect(panel).toContainText('7 min (1k words)', { timeout: 30000 });
  await expect(panel).toContainText('done', { timeout: 200000 });
  await panel.getByRole('button', { name: 'Copy JSON' }).click();
  // clipboard API may be unavailable (headless/insecure context) → textarea fallback
  const copied = panel.getByText('Copied ✓');
  const fallback = panel.locator('textarea[aria-label="Benchmark JSON"]');
  await expect(copied.or(fallback)).toBeVisible();

  // the markdown copy carries the table and the embedded JSON fence
  await panel.getByRole('button', { name: 'Copy MD' }).click();
  await expect(copied.or(fallback)).toBeVisible();
  const md = await page.evaluate(() =>
    navigator.clipboard && navigator.clipboard.readText
      ? navigator.clipboard.readText().catch(() => null) : null);
  if (md) {
    expect(md).toContain('| Speech | Words |');
    expect(md).toContain('```json');
  }

  // the download is the same markdown as a dated .md file
  const downloadPromise = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download .md' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^hle-benchmark-\d{4}-\d{2}-\d{2}\.md$/);
});

test('the benchmark runs in its own project and returns you to yours', async ({ page }) => {
  test.setTimeout(240000);
  await page.goto('/index.html?bench=1');
  await page.waitForSelector('#hypertranscript span[data-m]');

  // give the user a project to be returned to (a birth, as every engine does it)
  const homeId = await page.evaluate(async () => {
    document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    for (let i = 0; i < 50 && window.HyperaudioSave.library.currentId() === null; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return window.HyperaudioSave.library.currentId();
  });
  expect(homeId).not.toBeNull();

  const panel = page.locator('[aria-label="HLE limits benchmark"]');
  await panel.getByRole('button', { name: 'Run' }).click();
  await expect(panel).toContainText('done', { timeout: 200000 });

  const after = await page.evaluate(async () => ({
    currentId: window.HyperaudioSave.library.currentId(),
    names: (await window.HyperaudioSave.library.list()).map((e) => e.name),
  }));
  expect(after.currentId).toBe(homeId);                       // back where you were
  expect(after.names.filter((n) => n === 'Benchmark').length).toBe(1); // ONE bench project

  // the Benchmark project carries its own report: switch to it and check what
  // its ⓘ has to show — summary, transcription details, and honest media
  const info = await page.evaluate(async () => {
    const list = await window.HyperaudioSave.library.list();
    const bench = list.find((e) => e.name === 'Benchmark');
    await window.HyperaudioSave.library.open(bench.id);
    return {
      summary: document.getElementById('summary').textContent,
      transcription: document.getElementById('transcription-info').textContent,
      mediaKind: bench.media && bench.media.kind,
    };
  });
  expect(info.summary).toContain('Device benchmark');
  expect(info.summary).toContain('undo ×');
  expect(info.transcription).toContain('device benchmark');
  expect(info.mediaKind).toBe('none');   // the ⓘ media section reads "No media"
});

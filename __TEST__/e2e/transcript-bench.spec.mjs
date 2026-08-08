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
});

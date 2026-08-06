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

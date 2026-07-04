// Playwright end-to-end tests for the editor (see __TEST__/e2e/).
// The suite loads the real page from a static server and drives the shipped
// code — no production files are modified for testing.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '__TEST__/e2e',
  timeout: 120000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'python3 -m http.server 4173',
    port: 4173,
    reuseExistingServer: true,
  },
});

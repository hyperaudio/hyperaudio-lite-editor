// Soak tests (see __TEST__/soak/) — long-running leak detection, kept out of the
// e2e project deliberately: each spec drives one flow hundreds of times, so it
// runs in minutes rather than seconds and belongs in a nightly/on-demand run,
// not on every push. Serial and retry-free: a soak result is a measurement, and
// re-running a "failure" until it passes would defeat the point.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '__TEST__/soak',
  testMatch: '**/*.soak.spec.mjs',
  timeout: 15 * 60 * 1000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
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

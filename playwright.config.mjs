// Playwright end-to-end tests for the editor (see __TEST__/e2e/).
// The suite loads the real page from a static server and drives the shipped
// code — no production files are modified for testing.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '__TEST__/e2e',
  timeout: 120000,
  retries: process.env.CI ? 1 : 0,
  // Files run in parallel; each test's browser context is isolated (own
  // OPFS), so cross-test state cannot leak. Bounded rather than cores/2:
  // several tests assert against real-time debounces (the 1s sanitise, the
  // 500ms coalesce) and heavy CPU contention would make them flaky.
  workers: process.env.CI ? 2 : 4,
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1280, height: 800 },
    // The service worker takes control of a page as soon as it activates
    // (#665), and a request a worker answers is one page.route() never sees —
    // which is how the specs serve their fixture media. Blocked here, as
    // Playwright advises; service-worker.spec.mjs allows it and drives the
    // real worker through a server of its own.
    serviceWorkers: 'block',
  },
  webServer: {
    // NOT python's http.server: single-threaded, broken-pipe-prone under
    // Playwright load — it produced three-minute runs and phantom failures.
    command: 'node __TEST__/static-server.mjs',
    port: 4173,
    reuseExistingServer: true,
  },
});

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
  },
  // CI also writes JUnit XML, which the pages job publishes next to the Go
  // test results (rules/published-reports.md).
  reporter: process.env.CI
    ? [['list'], ['junit', { outputFile: 'e2e.xml' }]]
    : 'list',
  // Registers the very first user (who becomes admin) once, before any
  // test file runs — see the file's own header comment for why this
  // can't be a per-file beforeAll.
  globalSetup: './tests/admin-global-setup.ts',
  // Every test drives a real WebAuthn ceremony through Chrome's CDP virtual
  // authenticator against one shared Go binary. CI runs one worker. Locally
  // the default worker count stays: measured on #736, the server idles
  // (about 10% of one core, every request but the SSE stream under 50 ms)
  // and fewer workers didn't make failures go away, so the failures were
  // test races and a starved browser, not server contention. Use
  // tests/run-local.sh for a fresh database per run.
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 1 : 0,
});

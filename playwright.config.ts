import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    launchOptions: {
      // Every page links a Google Fonts stylesheet. It blocks rendering, so
      // `goto` waits on the `load` event for as long as that request hangs,
      // which on a loaded host or a flaky network is until the 30s timeout
      // (#740: login.html stalled once at load average 24). Resolving the
      // font hosts to localhost makes the request fail at once, so no test
      // depends on the network. Measured against the built binary: a
      // blackholed font host timed out at 8s, a refused one loaded in 55ms.
      args: [
        '--host-resolver-rules=MAP fonts.googleapis.com 127.0.0.1, MAP fonts.gstatic.com 127.0.0.1',
      ],
    },
  },
  reporter: 'list',
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

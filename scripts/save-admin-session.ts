// Registers the first (admin) user and saves its session to tests/.auth/admin.json,
// the same as Playwright's global setup. The Lighthouse job uses it to audit the
// signed-in pages without running the specs (scripts/lighthouse-session.js reads
// the file). Run with bun against a running server: E2E_BASE_URL defaults to
// http://localhost:8080.
import globalSetup from '../tests/admin-global-setup';

await globalSetup({
  projects: [
    { use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080' } },
  ],
} as never);

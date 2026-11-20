import path from 'node:path';
import { staleBinaryMessage } from '../scripts/stale-e2e-binary';

// The check itself, with the repo root and environment passed in so
// scripts/global-setup.test.ts can pin it. The binary embeds the web bundle at
// build time, so one older than the sources would let a spec pass against the
// old build. An E2E_BINARY names a binary built for this run
// (tests/run-local.sh, CI), so the check is skipped then.
export function checkE2EBinary(
  root: string,
  env: Record<string, string | undefined>,
): void {
  if (env.E2E_BINARY) return;
  const message = staleBinaryMessage(
    root,
    path.join(root, 'forge-dashboard-e2e'),
  );
  if (message !== null) throw new Error(message);
}

// Runs once per Playwright run, before any worker.
export default function globalSetup() {
  checkE2EBinary(path.join(__dirname, '..'), process.env);
}

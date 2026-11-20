import path from 'node:path';
import { staleBinaryMessage } from '../scripts/stale-e2e-binary';

// Runs once per Playwright run, before any worker. The binary embeds the web
// bundle at build time, so one older than the sources would let a spec pass
// against the old build. An E2E_BINARY names a binary built for this run
// (tests/run-local.sh, CI), so the check is skipped then.
export default function globalSetup() {
  if (process.env.E2E_BINARY) return;
  const root = path.join(__dirname, '..');
  const message = staleBinaryMessage(
    root,
    path.join(root, 'forge-dashboard-e2e'),
  );
  if (message !== null) throw new Error(message);
}

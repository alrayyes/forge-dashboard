import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// What the e2e binary is built from: Go sources, and the web bundle it embeds
// at build time.
const inputDirs = [
  'cmd',
  'internal',
  path.join('web', 'src'),
  path.join('web', 'static'),
];
const inputFiles = ['go.mod', 'go.sum'];

const buildCommand =
  'go build -tags e2e -o forge-dashboard-e2e ./cmd/forge-dashboard';

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

// The path (relative to root) of an input file modified after the binary, or
// null when the binary is at least as new as all of them.
export function newerInput(root: string, binary: string): string | null {
  const built = statSync(binary).mtimeMs;
  const candidates = [
    ...inputFiles.map((f) => path.join(root, f)).filter(existsSync),
    ...inputDirs.flatMap((d) => {
      const dir = path.join(root, d);
      return existsSync(dir) ? [...walk(dir)] : [];
    }),
  ];
  const newer = candidates.find((f) => statSync(f).mtimeMs > built);
  return newer === undefined ? null : path.relative(root, newer);
}

// The failure text for a stale or missing binary, or null when it is fresh.
export function staleBinaryMessage(
  root: string,
  binary: string,
): string | null {
  if (!existsSync(binary)) {
    return `e2e binary ${binary} does not exist. Build it:\n  bun run build:web && ${buildCommand}\nor run tests/run-local.sh.`;
  }
  const newer = newerInput(root, binary);
  if (newer === null) return null;
  return `e2e binary ${binary} is older than ${newer}, so a spec would run against an old build. Rebuild it:\n  bun run build:web && ${buildCommand}\nor run tests/run-local.sh. Set E2E_BINARY to skip this check.`;
}

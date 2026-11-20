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

// Go does not compile _test.go files or testdata directories into a binary.
const goDirs = new Set(['cmd', 'internal']);

function* walk(dir: string, go: boolean): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!(go && entry.name === 'testdata')) yield* walk(full, go);
    } else if (!(go && entry.name.endsWith('_test.go'))) yield full;
  }
}

// A file's mtime, or null for one that vanished or is a broken symlink. A
// dangling link is not compiled in (go:embed would refuse to build it), so it
// is no input; it must not hide a real one by throwing mid-walk.
function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export type StaleInput = {
  // Path relative to root.
  file: string;
  // True when the file is dated after `now`: the clock, not the binary, is
  // wrong, and no rebuild will ever make the binary newer than it.
  future: boolean;
};

// The input file modified after the binary, or null when the binary is at
// least as new as all of them. A future-dated file wins over an ordinary newer
// one, because it explains why a fresh rebuild would still read as stale.
export function staleInput(
  root: string,
  binary: string,
  now: number = Date.now(),
): StaleInput | null {
  const built = statSync(binary).mtimeMs;
  const candidates = [
    ...inputFiles.map((f) => path.join(root, f)).filter(existsSync),
    ...inputDirs.flatMap((d) => {
      const dir = path.join(root, d);
      return existsSync(dir) ? [...walk(dir, goDirs.has(d))] : [];
    }),
  ];
  const newer = candidates.filter((f) => (mtimeOf(f) ?? 0) > built);
  const future = newer.find((f) => (mtimeOf(f) ?? 0) > now);
  const file = future ?? newer[0];
  if (file === undefined) return null;
  return { file: path.relative(root, file), future: future !== undefined };
}

// The path (relative to root) of an input file modified after the binary, or
// null when the binary is at least as new as all of them.
export function newerInput(root: string, binary: string): string | null {
  return staleInput(root, binary)?.file ?? null;
}

// The failure text for a stale or missing binary, or null when it is fresh.
export function staleBinaryMessage(
  root: string,
  binary: string,
  now: number = Date.now(),
): string | null {
  if (!existsSync(binary)) {
    return `e2e binary ${binary} does not exist. Build it:\n  bun run build:web && ${buildCommand}\nor run tests/run-local.sh.`;
  }
  const stale = staleInput(root, binary, now);
  if (stale === null) return null;
  if (stale.future) {
    return `${stale.file} is dated in the future, so no rebuild can make e2e binary ${binary} newer than it. Fix the file's modification time (touch ${stale.file}) or the system clock, then rebuild:\n  bun run build:web && ${buildCommand}\nor run tests/run-local.sh. Set E2E_BINARY to skip this check.`;
  }
  return `e2e binary ${binary} is older than ${stale.file}, so a spec would run against an old build. Rebuild it:\n  bun run build:web && ${buildCommand}\nor run tests/run-local.sh. Set E2E_BINARY to skip this check.`;
}

import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkE2EBinary } from '../tests/global-setup';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// A throwaway repo whose default binary sits at second 1000 and whose Go
// source is dated `sourceSecs`; null leaves the binary out.
function repo(sourceSecs: number, withBinary = true): string {
  const root = mkdtempSync(path.join(tmpdir(), 'global-setup-'));
  roots.push(root);
  if (withBinary) {
    const bin = path.join(root, 'forge-dashboard-e2e');
    writeFileSync(bin, '');
    utimesSync(bin, 1000, 1000);
  }
  mkdirSync(path.join(root, 'internal'));
  const src = path.join(root, 'internal', 'a.go');
  writeFileSync(src, '');
  utimesSync(src, sourceSecs, sourceSecs);
  return root;
}

test('throws the stale-binary message when no E2E_BINARY is set', () => {
  const root = repo(1100);
  expect(() => checkE2EBinary(root, {})).toThrow(path.join('internal', 'a.go'));
});

test('throws for a missing default binary', () => {
  const root = repo(900, false);
  expect(() => checkE2EBinary(root, {})).toThrow('does not exist');
});

test('passes for a fresh default binary', () => {
  expect(() => checkE2EBinary(repo(900), {})).not.toThrow();
});

test('skips the check when E2E_BINARY names a binary, however stale the default is', () => {
  const root = repo(1100);
  expect(() =>
    checkE2EBinary(root, { E2E_BINARY: '/tmp/some/binary' }),
  ).not.toThrow();
});

test('an empty E2E_BINARY does not skip the check', () => {
  const root = repo(1100);
  expect(() => checkE2EBinary(root, { E2E_BINARY: '' })).toThrow();
});

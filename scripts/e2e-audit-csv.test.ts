import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// docs/e2e-audit/spec-classes.csv is generated, never edited by hand. This
// reruns the classifier and compares, so a spec added or changed without a
// regeneration fails here instead of leaving a stale count for the next slice
// to trust. The fix is the command in docs/e2e-audit.md.
const root = path.resolve(import.meta.dir, '..');
const csv = path.join(root, 'docs/e2e-audit/spec-classes.csv');

test('spec-classes.csv is what classify.py computes from tests/', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-audit-'));
  try {
    const out = path.join(dir, 'spec-classes.csv');
    const run = Bun.spawnSync([
      'python3',
      path.join(root, 'docs/e2e-audit/classify.py'),
      root,
      out,
    ]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const regenerate =
      'regenerate it: python3 docs/e2e-audit/classify.py . docs/e2e-audit/spec-classes.csv';
    expect(readFileSync(csv, 'utf8'), regenerate).toBe(
      readFileSync(out, 'utf8'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

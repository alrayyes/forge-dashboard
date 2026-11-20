import { expect, test } from 'bun:test';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

// A scratch tree with the script beside its own annotations file, and one spec.
function scratch(annotations: string | null): {
  dir: string;
  run: () => ReturnType<typeof Bun.spawnSync>;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-audit-'));
  mkdirSync(path.join(dir, 'docs/e2e-audit'), { recursive: true });
  mkdirSync(path.join(dir, 'tests'));
  copyFileSync(
    path.join(root, 'docs/e2e-audit/classify.py'),
    path.join(dir, 'docs/e2e-audit/classify.py'),
  );
  writeFileSync(path.join(dir, 'tests/e2e-durations.json'), '{}');
  writeFileSync(path.join(dir, 'tests/a.spec.ts'), "test('x', () => {});\n");
  if (annotations !== null)
    writeFileSync(
      path.join(dir, 'docs/e2e-audit/lower-annotations.json'),
      annotations,
    );
  return {
    dir,
    run: () =>
      Bun.spawnSync([
        'python3',
        path.join(dir, 'docs/e2e-audit/classify.py'),
        dir,
        path.join(dir, 'out.csv'),
      ]),
  };
}

test('a missing lower-annotations.json is an error that names the file', () => {
  const s = scratch(null);
  try {
    const r = s.run();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain('lower-annotations.json');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('an annotation for a spec that no longer exists is an error that names it', () => {
  const s = scratch('{"gone.spec.ts": ["x (proven)"]}');
  try {
    const r = s.run();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain('gone.spec.ts');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('an annotation for a spec that exists is accepted', () => {
  const s = scratch('{"a.spec.ts": ["x (proven)"]}');
  try {
    expect(s.run().exitCode).toBe(0);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

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
    // The prefix is what separates classify.py's own exit from the
    // FileNotFoundError traceback, which names the file too.
    expect(r.stderr.toString()).toContain('classify.py: missing');
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

// Counts typed into the doc were edited by every pull request that added a
// spec, a test or a lib unit test, so any two of them conflicted on the line
// and every merge to main turned the rest DIRTY. The doc states none: the
// numbers are the rows of docs/e2e-audit/spec-classes.csv, which regenerates
// with the one command above and conflicts only when two pull requests touch
// the same spec.
// The old checks matched one phrasing each, so "(309 files and 2738 tests)" or
// "has 152 test files" slipped through. Any number followed by files, tests or
// test files is a count a spec change would edit.
const handWrittenCount = (text: string): string | null =>
  /\d[\d,]*\s+(?:test\s+)?(?:files|tests)\b/.exec(text)?.[0] ?? null;

for (const [name, text, found] of [
  ['files and tests', '(309 files and 2738 tests)', '309 files'],
  ['test files', 'it has 152 test files', '152 test files'],
  ['files', 'across 12 files', '12 files'],
  ['tests', 'now 2,738 tests', '2,738 tests'],
  ['a count wrapped onto the next line', '49\ntests', '49\ntests'],
  ['the old phrasing', '(309 files, 2738 tests)', '309 files'],
] as const)
  test(`a hand-written count is caught: ${name}`, () => {
    expect(handWrittenCount(text)).toBe(found);
  });

test('prose with no count is not caught', () => {
  expect(handWrittenCount('the tests and files in the CSV')).toBeNull();
});

test('docs/e2e-audit.md states no counts that a spec or test change would edit', () => {
  const doc = readFileSync(path.join(root, 'docs/e2e-audit.md'), 'utf8');
  expect(
    handWrittenCount(doc),
    'put the spec and test counts back in the CSV, not here; regenerate it: python3 docs/e2e-audit/classify.py . docs/e2e-audit/spec-classes.csv',
  ).toBeNull();
});

import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = path.join(import.meta.dir, 'lint-mechanics.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A throwaway repository holding a copy of the script, a tracked tree of
// Markdown, and a fake ltex-cli-plus on PATH that records what it was given.
function repo(files: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mechanics-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'scripts'));
  copyFileSync(script, path.join(dir, 'scripts', 'lint-mechanics.sh'));
  writeFileSync(path.join(dir, '.ltex.json'), '{}');
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), 'Hello.\n');
  }
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const fake = path.join(bin, 'ltex-cli-plus');
  writeFileSync(
    fake,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/received.txt"\nexit "\${FAKE_LTEX_STATUS:-0}"\n`,
  );
  chmodSync(fake, 0o755);
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  return {
    dir,
    run(args: string[], env: Record<string, string> = {}) {
      const r = spawnSync('bash', ['scripts/lint-mechanics.sh', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
      });
      let received: string[] | null = null;
      try {
        received = readFileSync(path.join(dir, 'received.txt'), 'utf8')
          .split('\n')
          .filter((l) => l && !l.startsWith('--client-configuration'));
      } catch {
        received = null;
      }
      return { status: r.status, out: r.stdout + r.stderr, received };
    },
  };
}

const tree = ['README.md', 'docs/a.md', 'docs/b.md', 'CHANGELOG.md', 'src.ts'];

test('a bare run checks every tracked Markdown file', () => {
  const r = repo(tree).run([]);
  expect(r.status).toBe(0);
  expect(r.received?.sort()).toEqual(['README.md', 'docs/a.md', 'docs/b.md']);
});

test('a push of Markdown checks only the pushed files', () => {
  const r = repo(tree).run(['docs/a.md', 'src.ts']);
  expect(r.status).toBe(0);
  expect(r.received).toEqual(['docs/a.md']);
});

test('pushed files still go through the usual exclusions', () => {
  const r = repo([...tree, 'openspec/changes/x/p.md', '.claude/n.md']).run([
    'docs/a.md',
    'CHANGELOG.md',
    'openspec/changes/x/p.md',
    '.claude/n.md',
  ]);
  expect(r.received).toEqual(['docs/a.md']);
});

test('a push with no prose says so and never starts ltex', () => {
  const r = repo(tree).run(['src.ts', 'CHANGELOG.md']);
  expect(r.status).toBe(0);
  expect(r.received).toBeNull();
  expect(r.out).toContain('No Markdown');
});

test('a pushed file that no longer exists is not handed to ltex', () => {
  const r = repo(tree).run(['docs/a.md', 'docs/deleted.md']);
  expect(r.received).toEqual(['docs/a.md']);
});

for (const trigger of ['.ltex.json', 'scripts/lint-mechanics.sh']) {
  test(`${trigger} in the push checks the whole tree`, () => {
    const r = repo(tree).run([trigger, 'docs/a.md']);
    expect(r.received?.sort()).toEqual(['README.md', 'docs/a.md', 'docs/b.md']);
  });
}

test('an ltex finding still fails the script', () => {
  const r = repo(tree).run(['docs/a.md'], { FAKE_LTEX_STATUS: '3' });
  expect(r.status).toBe(1);
});

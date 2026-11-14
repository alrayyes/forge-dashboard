/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dir, '..');

// A failed Playwright run leaves error-context.md files in the gitignored
// test-results/ directory. They are not this repo's prose, and linting them
// failed the next push.
test('lint:md ignores the gitignored test-results directory', () => {
  const dir = path.join(root, 'test-results', 'markdownlint-ignores-fixture');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'error-context.md'), 'no heading\n\n\n');
    const run = Bun.spawnSync(['bunx', 'markdownlint-cli2'], { cwd: root });
    expect(run.stderr.toString()).not.toContain('test-results');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

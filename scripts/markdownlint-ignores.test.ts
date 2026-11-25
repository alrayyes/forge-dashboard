/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dir, '..');

// A real markdownlint run takes a few seconds alone and over 30 s on a busy machine.
const LOADED_MACHINE_TIMEOUT_MS = 90_000;

// A failed Playwright or Vitest run leaves error-context.md files in a
// gitignored test-results/ directory, at the root or under web/. They are not
// this repo's prose, and linting them failed the next push.
for (const base of ['test-results', 'web/test-results']) {
  test(
    `lint:md ignores the gitignored ${base} directory`,
    () => {
      const dir = path.join(root, base, 'markdownlint-ignores-fixture');
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'error-context.md'), 'no heading\n\n\n');
        const run = Bun.spawnSync(['bunx', 'markdownlint-cli2'], { cwd: root });
        const output = run.stdout.toString() + run.stderr.toString();
        // The run must have started, or "no finding" proves nothing.
        expect(output).toContain('markdownlint-cli2');
        // The banner lists the ignore globs, so look for a finding on a file path.
        expect(output).not.toMatch(/^(web\/)?test-results\//m);
      } finally {
        rmSync(path.join(root, base, 'markdownlint-ignores-fixture'), {
          recursive: true,
          force: true,
        });
      }
    },
    LOADED_MACHINE_TIMEOUT_MS,
  );
}

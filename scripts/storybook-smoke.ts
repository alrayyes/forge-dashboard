// Smoke test for the Storybook catalog (#3239): the build succeeds and
// index.json lists at least one story. It builds, so it is not named
// *.test.ts, which `bun run test:unit` would pick up on every push. Run it
// with `bun run test:storybook`.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const webDir = path.join(import.meta.dir, '..', 'web');

test('storybook build succeeds and index.json lists at least one story', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'storybook-smoke-'));
  try {
    const build = Bun.spawnSync(
      ['bunx', 'storybook', 'build', '--quiet', '-o', out],
      { cwd: webDir, stdout: 'inherit', stderr: 'inherit' },
    );
    expect(build.exitCode).toBe(0);
    const index = JSON.parse(
      readFileSync(path.join(out, 'index.json'), 'utf8'),
    );
    const stories = Object.values<{ type: string }>(index.entries).filter(
      (e) => e.type === 'story',
    );
    expect(stories.length).toBeGreaterThan(0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 240_000);

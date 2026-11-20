import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newerInput, staleBinaryMessage } from './stale-e2e-binary';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// A throwaway repo with the binary at second 1000 and each input at the given
// second; returns the repo root and the binary path.
function repo(inputs: Record<string, number>): { root: string; bin: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'stale-e2e-'));
  roots.push(root);
  const bin = path.join(root, 'forge-dashboard-e2e');
  writeFileSync(bin, '');
  utimesSync(bin, 1000, 1000);
  for (const [rel, secs] of Object.entries(inputs)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    utimesSync(file, secs, secs);
  }
  return { root, bin };
}

test('names the input that is newer than the binary', () => {
  const { root, bin } = repo({
    'internal/a.go': 900,
    'internal/deep/b.go': 1100,
  });
  expect(newerInput(root, bin)).toBe(path.join('internal', 'deep', 'b.go'));
});

test('is null when the binary is newer than every input', () => {
  const { root, bin } = repo({
    'cmd/main.go': 900,
    'web/src/App.svelte': 999,
    'go.mod': 10,
  });
  expect(newerInput(root, bin)).toBeNull();
});

test('counts go.mod, go.sum and web/static as inputs, and tolerates a missing directory', () => {
  for (const rel of [
    'go.mod',
    'go.sum',
    'cmd/m.go',
    'web/static/x.css',
    'web/src/y.ts',
  ]) {
    const { root, bin } = repo({ [rel]: 1100 });
    expect(newerInput(root, bin)).toBe(path.normalize(rel));
  }
});

test('ignores files outside the inputs', () => {
  const { root, bin } = repo({ 'docs/readme.md': 1100, 'tests/a.ts': 1100 });
  expect(newerInput(root, bin)).toBeNull();
});

test('is null for a binary of the same age as an input', () => {
  const { root, bin } = repo({ 'cmd/a.go': 1000 });
  expect(newerInput(root, bin)).toBeNull();
});

test('reports a missing binary as stale with the build command', () => {
  const { root } = repo({});
  const msg = staleBinaryMessage(root, path.join(root, 'nope'));
  expect(msg).toContain(
    'go build -tags e2e -o forge-dashboard-e2e ./cmd/forge-dashboard',
  );
});

test('the message names the newer file and both build commands', () => {
  const { root, bin } = repo({ 'internal/a.go': 1100 });
  const msg = staleBinaryMessage(root, bin);
  expect(msg).toContain(path.join('internal', 'a.go'));
  expect(msg).toContain('bun run build:web');
  expect(msg).toContain(
    'go build -tags e2e -o forge-dashboard-e2e ./cmd/forge-dashboard',
  );
  expect(staleBinaryMessage(root, bin)).not.toBeNull();
});

test('the message is null for a fresh binary', () => {
  const { root, bin } = repo({ 'internal/a.go': 900 });
  expect(staleBinaryMessage(root, bin)).toBeNull();
});

test('ignores Go test files and testdata, which are not compiled into the binary', () => {
  const { root, bin } = repo({
    'internal/a_test.go': 1100,
    'cmd/forge-dashboard/main_test.go': 1100,
    'internal/dashboard/testdata/case.json': 1100,
  });
  expect(newerInput(root, bin)).toBeNull();
});

test('still counts a non-test Go file whose name only contains test', () => {
  const { root, bin } = repo({ 'internal/testing_helpers.go': 1100 });
  expect(newerInput(root, bin)).toBe(
    path.join('internal', 'testing_helpers.go'),
  );
});

test('skips a broken symlink instead of throwing, and still finds a real stale input', () => {
  const { root, bin } = repo({ 'internal/real.go': 1100 });
  symlinkSync(
    path.join(root, 'gone.go'),
    path.join(root, 'internal', 'aaa-dangling.go'),
  );
  expect(newerInput(root, bin)).toBe(path.join('internal', 'real.go'));
});

test('is null when the only odd entry is a broken symlink', () => {
  const { root, bin } = repo({ 'internal/real.go': 900 });
  symlinkSync(
    path.join(root, 'gone.go'),
    path.join(root, 'internal', 'dangling.go'),
  );
  expect(newerInput(root, bin)).toBeNull();
});

test('says a future-dated input is the reason, not that the binary is old', () => {
  const { root, bin } = repo({ 'internal/clock.go': 5000 });
  const now = 2000 * 1000;
  const msg = staleBinaryMessage(root, bin, now);
  expect(msg).toContain(path.join('internal', 'clock.go'));
  expect(msg).toContain('dated in the future');
  expect(msg).not.toContain('is older than');
});

test('a newer input that is not in the future still says the binary is older', () => {
  const { root, bin } = repo({ 'internal/a.go': 1100 });
  const msg = staleBinaryMessage(root, bin, 2000 * 1000);
  expect(msg).toContain('is older than');
  expect(msg).not.toContain('dated in the future');
});

test('fails when the web bundle was synced before the last web edit, even though the binary is newer', () => {
  const { root, bin } = repo({
    'web/src/routes/page.svelte': 900,
    'internal/api/static/_app/version.json': 800,
  });
  const msg = staleBinaryMessage(root, bin);
  expect(msg).toContain(
    `${path.join('internal', 'api', 'static')} was synced before ${path.join('web', 'src', 'routes', 'page.svelte')}`,
  );
  expect(msg).toContain('Run bun run build:web first');
  expect(msg).not.toContain('is older than');
});

test('a web/static edit after the sync counts the same way', () => {
  const { root, bin } = repo({
    'web/static/icon.svg': 900,
    'internal/api/static/_app/version.json': 800,
  });
  expect(staleBinaryMessage(root, bin)).toContain(
    path.join('web', 'static', 'icon.svg'),
  );
});

test('passes when the bundle was synced after the last web edit', () => {
  const { root, bin } = repo({
    'web/src/routes/page.svelte': 800,
    'web/static/icon.svg': 810,
    'internal/api/static/_app/version.json': 900,
  });
  expect(staleBinaryMessage(root, bin)).toBeNull();
});

test('compares against the newest synced file, not the oldest', () => {
  const { root, bin } = repo({
    'web/src/page.svelte': 900,
    'internal/api/static/_app/old.js': 100,
    'internal/api/static/_app/immutable/new.js': 950,
  });
  expect(staleBinaryMessage(root, bin)).toBeNull();
});

test('does not demand a sync when the repo never built the web bundle', () => {
  const { root, bin } = repo({ 'web/src/page.svelte': 900 });
  expect(staleBinaryMessage(root, bin)).toBeNull();
});

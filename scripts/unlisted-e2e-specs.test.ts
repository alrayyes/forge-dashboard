import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unlistedSpecs } from './unlisted-e2e-specs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function testDir(files: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-specs-'));
  dirs.push(dir);
  for (const f of files) writeFileSync(path.join(dir, f), '');
  return dir;
}

test('a spec the list names is not reported', () => {
  const dir = testDir(['a.spec.ts']);
  expect(unlistedSpecs(dir, ['**/a.spec.ts'])).toEqual([]);
});

test('a spec the list does not name is reported', () => {
  const dir = testDir(['a.spec.ts', 'b.spec.ts']);
  expect(unlistedSpecs(dir, ['**/a.spec.ts'])).toEqual(['b.spec.ts']);
});

test('a listed entry with no spec behind it is reported', () => {
  const dir = testDir(['a.spec.ts']);
  expect(unlistedSpecs(dir, ['**/a.spec.ts', '**/renamed.spec.ts'])).toEqual([
    'renamed.spec.ts',
  ]);
});

test('helpers that are not specs are ignored', () => {
  const dir = testDir(['a.spec.ts', 'helper.ts']);
  expect(unlistedSpecs(dir, ['**/a.spec.ts'])).toEqual([]);
});

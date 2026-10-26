/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { type MainBranches, supersedes } from './main-branches';

// A fallback read can answer after a newer stream message: the older rows must
// not replace the newer ones (#2884).

const page = (generatedAt: string) => ({ generatedAt }) as MainBranches;

describe('supersedes', () => {
  test('a page replaces nothing-yet and an older page', () => {
    expect(supersedes(page('2026-10-26T10:00:01Z'), null)).toBe(true);
    expect(
      supersedes(page('2026-10-26T10:00:01Z'), page('2026-10-26T10:00:00Z')),
    ).toBe(true);
  });

  test('a page from the same moment replaces it, as a redraw', () => {
    expect(
      supersedes(page('2026-10-26T10:00:00Z'), page('2026-10-26T10:00:00Z')),
    ).toBe(true);
  });

  test('an older page does not replace a newer one', () => {
    expect(
      supersedes(page('2026-10-26T10:00:00Z'), page('2026-10-26T10:00:01Z')),
    ).toBe(false);
  });

  test('a page whose time cannot be read is taken, not dropped', () => {
    expect(supersedes(page('nope'), page('2026-10-26T10:00:01Z'))).toBe(true);
  });
});

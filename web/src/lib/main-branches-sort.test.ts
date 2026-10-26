/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { isStale, type MainBranch, sortMainBranches } from './main-branches';

// The server sends rows unsorted; the page orders them (#2886).

const row = (
  forge: string,
  fullName: string,
  committedAt: string | null | undefined,
  extra: Partial<MainBranch> = {},
) =>
  ({
    forge,
    fullName,
    commit: committedAt === undefined ? null : { committedAt },
    staleSince: null,
    ...extra,
  }) as unknown as MainBranch;

const names = (rows: MainBranch[]) =>
  rows.map((r) => `${r.forge}:${r.fullName}`);

describe('sortMainBranches', () => {
  test('newest commit first, undated rows last, ties by name then forge', () => {
    const rows = [
      row('github', 'o/d', undefined),
      row('github', 'o/c', null),
      row('github', 'o/old-failed', '2026-10-01T01:00:00Z'),
      row('github', 'o/new-passed', '2026-10-03T00:00:00Z'),
      row('forgejo', 'o/tie', '2026-10-02T00:00:00Z'),
      row('github', 'o/tie', '2026-10-02T00:00:00Z'),
      row('github', 'o/a-tie', '2026-10-02T00:00:00Z'),
    ];

    expect(names(sortMainBranches(rows))).toEqual([
      'github:o/new-passed',
      'github:o/a-tie',
      'forgejo:o/tie',
      'github:o/tie',
      'github:o/old-failed',
      'github:o/c',
      'github:o/d',
    ]);
  });

  test('does not reorder the rows it is given', () => {
    const rows = [
      row('github', 'o/b', null),
      row('github', 'o/a', '2026-10-01T00:00:00Z'),
    ];

    sortMainBranches(rows);

    expect(names(rows)).toEqual(['github:o/b', 'github:o/a']);
  });

  test('a commit time that cannot be read counts as undated', () => {
    const rows = [
      row('github', 'o/a', 'nope'),
      row('github', 'o/b', '2026-10-01T00:00:00Z'),
    ];

    expect(names(sortMainBranches(rows))).toEqual(['github:o/b', 'github:o/a']);
  });
});

describe('isStale', () => {
  test('a row with staleSince is stale, one without is not', () => {
    const since = '2026-10-26T09:00:00Z';

    expect(isStale(row('github', 'o/a', null, { staleSince: since }))).toBe(
      true,
    );
    expect(isStale(row('github', 'o/a', null))).toBe(false);
  });
});

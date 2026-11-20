/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { MainBranch } from './main-branches';
import type { NavCounts, ServerNavCounts } from './nav-counts.svelte';
import { nextNavCounts } from './nav-counts-next';

// A later snapshot that carries no navCounts says nothing about them, so the
// counts already known stay and the links already drawn stay drawn. Only the
// server's first refresh running (null) makes them unknown again.
// https://github.com/alrayyes/forge-dashboard/issues/4318

const raw: ServerNavCounts = {
  pullRequests: { total: 3, failed: 1 },
  issues: { total: 5 },
  releases: { total: 1, failed: 0 },
  bots: { total: 2, failed: 0 },
};

const known: NavCounts = {
  branches: { total: 4, failed: 0 },
  pullRequests: { total: 3, failed: 1 },
  issues: { total: 5, failed: 0 },
  releases: { total: 1, failed: 0 },
  bots: { total: 2, failed: 0 },
};

const failedRow = {
  forge: 'github',
  fullName: 'a/b',
  status: 'failed',
} as MainBranch;

describe('nextNavCounts', () => {
  test('a snapshot with counts replaces what was known', () => {
    const older: NavCounts = {
      ...known,
      pullRequests: { total: 9, failed: 9 },
    };
    const next = nextNavCounts(older, raw, true, [], null);
    expect(next?.pullRequests).toEqual({ total: 3, failed: 1 });
    expect(next?.issues).toEqual({ total: 5, failed: 0 });
  });

  test('Branches is counted from the snapshot rows when the page gave none', () => {
    const next = nextNavCounts(null, raw, true, [failedRow], null);
    expect(next?.branches.total).toBe(1);
    expect(next?.branches.failed).toBe(1);
  });

  test('a snapshot without navCounts keeps the known counts', () => {
    expect(nextNavCounts(known, undefined, true, [], null)).toBe(known);
  });

  test('counts not yet known stay unknown without navCounts', () => {
    expect(nextNavCounts(null, undefined, true, [], null)).toBeNull();
  });

  test('the first refresh running makes known counts unknown', () => {
    expect(nextNavCounts(known, null, true, [], null)).toBeNull();
  });

  test('a count that went to zero is known as zero, not kept', () => {
    const next = nextNavCounts(
      known,
      { ...raw, bots: { total: 0, failed: 0 } },
      true,
      [],
      null,
    );
    expect(next?.bots.total).toBe(0);
  });

  test('the Branches page count wins over the snapshot rows', () => {
    const page = { total: 9, failed: 2 };
    expect(nextNavCounts(null, raw, true, [], page)?.branches).toBe(page);
  });

  test('every field comes from its own source, not another field or the old counts', () => {
    const older: NavCounts = {
      branches: { total: 40, failed: 4 },
      pullRequests: { total: 41, failed: 5 },
      issues: { total: 42, failed: 6 },
      releases: { total: 43, failed: 7 },
      bots: { total: 44, failed: 8 },
    };
    const incoming: ServerNavCounts = {
      pullRequests: { total: 1, failed: 0 },
      issues: { total: 2 },
      releases: { total: 3, failed: 0 },
      bots: { total: 4, failed: 0 },
    };
    const next = nextNavCounts(older, incoming, true, [failedRow], null);
    expect(next?.branches.total).toBe(1);
    expect(next?.branches.failed).toBe(1);
    expect(next?.pullRequests).toEqual({ total: 1, failed: 0 });
    expect(next?.issues).toEqual({ total: 2, failed: 0 });
    expect(next?.releases).toEqual({ total: 3, failed: 0 });
    expect(next?.bots).toEqual({ total: 4, failed: 0 });
    const page = { total: 45, failed: 9 };
    expect(
      nextNavCounts(older, incoming, true, [failedRow], page)?.branches,
    ).toBe(page);
  });

  test('the first refresh running makes counts unknown even when the snapshot carries them', () => {
    expect(nextNavCounts(known, raw, false, [], null)).toBeNull();
    expect(nextNavCounts(null, raw, false, [], null)).toBeNull();
  });

  test('the first refresh running wins over a snapshot without navCounts', () => {
    expect(nextNavCounts(known, undefined, false, [], null)).toBeNull();
  });

  test('a snapshot with no flag counts as past the first refresh', () => {
    expect(nextNavCounts(null, raw, undefined, [], null)).not.toBeNull();
    expect(nextNavCounts(null, raw, null, [], null)).not.toBeNull();
  });
});

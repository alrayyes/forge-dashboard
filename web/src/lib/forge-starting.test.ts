/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  chipClass,
  chipLabel,
  healthSentence,
  isOutage,
  isStartupGap,
  isUnreachable,
  needsChip,
  splitStaleRows,
  staleNote,
} from './forge-starting';

const base = { forge: 'github', reachable: false };
const starting = { ...base, starting: true };

describe('forge-starting', () => {
  test('a forge that has not been asked yet is loading, never unreachable', () => {
    expect(chipLabel('GitHub', starting)).toBe('GitHub loading');
    expect(healthSentence('GitHub', starting)).toBe('GitHub starting up');
    expect(isOutage(starting)).toBe(false);
  });

  test('a forge whose fetch failed is still unreachable', () => {
    expect(chipLabel('GitHub', base)).toBe('GitHub unreachable');
    expect(healthSentence('GitHub', base)).toBe('GitHub unreachable');
    expect(isOutage(base)).toBe(true);
  });

  test('a reachable forge is reachable', () => {
    const ok = { forge: 'github', reachable: true };
    expect(chipLabel('GitHub', ok)).toBe('GitHub reachable');
    expect(isOutage(ok)).toBe(false);
  });

  test('the stale note says the app is starting up while no fetch has answered', () => {
    expect(staleNote(starting, 'a minute ago')).toBe(
      'Starting up, showing data from a minute ago',
    );
    expect(staleNote(base, 'a minute ago')).toBeNull();
    expect(staleNote({ ...base, staleSince: 'x' }, 'a minute ago')).toBe(
      'Showing data from a minute ago',
    );
  });
});

describe('isStartupGap', () => {
  const failed = { ...base, errorKind: 'unreachable' };

  test('a forge that has not answered right after a restart is starting up, not down', () => {
    expect(isStartupGap(failed, true)).toBe(true);
    expect(isStartupGap(base, true)).toBe(true);
    expect(isStartupGap({ ...base, errorKind: 'upstream_error' }, true)).toBe(
      true,
    );
  });

  test('the same failure once the server has been up a while is an outage', () => {
    expect(isStartupGap(failed, false)).toBe(false);
    expect(isStartupGap(failed, undefined)).toBe(false);
  });

  test('a bad token or instance URL is never a start-up gap', () => {
    expect(isStartupGap({ ...base, errorKind: 'unauthorized' }, true)).toBe(
      false,
    );
    expect(isStartupGap({ ...base, errorKind: 'not_found' }, true)).toBe(false);
  });

  test('a reachable forge and one already marked starting are not outages to reword', () => {
    expect(isStartupGap({ forge: 'github', reachable: true }, true)).toBe(
      false,
    );
    expect(isStartupGap(starting, true)).toBe(false);
  });
});

describe('chipClass', () => {
  test('names the state so style and wording stay together', () => {
    expect(chipClass(starting)).toBe('forge-health starting');
    expect(chipClass(base)).toBe('forge-health unreachable');
    expect(chipClass({ forge: 'github', reachable: true })).toBe(
      'forge-health',
    );
  });
});

describe('splitStaleRows', () => {
  test('rows of a starting forge are apart from rows of an outage', () => {
    const rows = [
      { forge: 'github', n: 1 },
      { forge: 'forgejo', n: 2 },
    ];
    const forges = [starting, { forge: 'forgejo', reachable: false }];
    const { starting: s, outage } = splitStaleRows(rows, forges);
    expect(s.map((r) => r.n)).toEqual([1]);
    expect(outage.map((r) => r.n)).toEqual([2]);
  });
});

describe('isUnreachable', () => {
  test('only an entry that says so', () => {
    expect(isUnreachable({ reachable: false })).toBe(true);
    expect(isUnreachable({ reachable: true })).toBe(false);
    expect(isUnreachable({})).toBe(false);
  });

  test('is the one rule the outage check follows', () => {
    expect(isOutage({ forge: 'github', reachable: true })).toBe(false);
    expect(isOutage({ forge: 'github', reachable: false })).toBe(true);
    expect(
      isOutage({ forge: 'github', reachable: false, starting: true }),
    ).toBe(false);
  });
});

describe('needsChip', () => {
  test('a healthy reachable forge draws no chip', () => {
    expect(needsChip({ forge: 'github', reachable: true }, false)).toBe(false);
  });

  test('starting, stale and rate limited forges keep their chip', () => {
    expect(
      needsChip({ forge: 'github', reachable: true, starting: true }, false),
    ).toBe(true);
    expect(
      needsChip(
        {
          forge: 'github',
          reachable: true,
          staleSince: '2030-01-01T00:00:00Z',
        },
        false,
      ),
    ).toBe(true);
    expect(needsChip({ forge: 'github', reachable: true }, true)).toBe(true);
  });
});

describe('needsChip for an outage (#3719)', () => {
  test('an unreachable forge draws no chip: the banner says it once', () => {
    expect(needsChip({ forge: 'github', reachable: false }, false)).toBe(false);
    expect(
      needsChip(
        {
          forge: 'github',
          reachable: false,
          staleSince: '2030-01-01T00:00:00Z',
        },
        false,
      ),
    ).toBe(false);
  });

  test('a start-up gap still draws its loading chip', () => {
    expect(
      needsChip({ forge: 'github', reachable: false, starting: true }, false),
    ).toBe(true);
  });

  test('an unreachable forge that is also rate limited keeps its chip: no unreachable banner covers it', () => {
    expect(needsChip({ forge: 'github', reachable: false }, true)).toBe(true);
  });
});

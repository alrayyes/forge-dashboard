/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  chipClass,
  chipLabel,
  healthSentence,
  isOutage,
  isUnreachable,
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

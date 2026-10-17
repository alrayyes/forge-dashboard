/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  branchesAwaitingFlag,
  FIRST_REFRESH_SHOW_DELAY_MS,
  FIRST_REFRESH_SLOW_MS,
  firstRefreshLoading,
  firstRefreshPending,
  firstRefreshStatus,
  hasTimestamp,
} from './first-refresh';

// The page does not decide whether it has loaded; the server says so with
// `firstRefreshDone`. This is only the rule for what to draw from that answer.
// https://github.com/alrayyes/forge-dashboard/issues/1672

describe('firstRefreshPending', () => {
  test('is pending only while the server says the first refresh is not done', () => {
    expect(firstRefreshPending(false)).toBe(true);
  });

  test('is not pending once the server says it is done', () => {
    expect(firstRefreshPending(true)).toBe(false);
  });

  test('a missing flag counts as loaded, so an older server changes nothing', () => {
    expect(firstRefreshPending(undefined)).toBe(false);
    expect(firstRefreshPending(null)).toBe(false);
  });
});

describe('firstRefreshStatus', () => {
  test('says nothing when not pending', () => {
    expect(firstRefreshStatus(false, 0)).toBe('');
    expect(firstRefreshStatus(false, FIRST_REFRESH_SLOW_MS * 3)).toBe('');
  });

  test('says it is loading at first', () => {
    expect(firstRefreshStatus(true, 0)).toBe('Loading your repositories…');
    expect(firstRefreshStatus(true, FIRST_REFRESH_SLOW_MS - 1)).toBe(
      'Loading your repositories…',
    );
  });

  test('says it can take a while after about ten seconds', () => {
    expect(firstRefreshStatus(true, FIRST_REFRESH_SLOW_MS)).toBe(
      'Still loading. The first refresh can take a while after a restart.',
    );
  });
});

describe('branchesAwaitingFlag', () => {
  test('waits while the flag request is open and the list is empty', () => {
    expect(branchesAwaitingFlag(false, 0)).toBe(true);
  });

  test('never waits once the request has settled, even when it failed', () => {
    expect(branchesAwaitingFlag(true, 0)).toBe(false);
  });

  test('never hides rows that are already there', () => {
    expect(branchesAwaitingFlag(false, 3)).toBe(false);
  });
});

describe('firstRefreshLoading', () => {
  const unanswered = { done: undefined, settled: false, waited: false };

  test('draws nothing before the show delay, so a warm load never flashes', () => {
    expect(firstRefreshLoading(unanswered)).toBe(false);
  });

  test('is loading once the delay has run out with no answer yet', () => {
    expect(firstRefreshLoading({ ...unanswered, waited: true })).toBe(true);
  });

  test('the delay is a fifth of a second', () => {
    expect(FIRST_REFRESH_SHOW_DELAY_MS).toBe(200);
  });

  test('an answer of false is loading at once, without waiting', () => {
    expect(
      firstRefreshLoading({ done: false, settled: true, waited: false }),
    ).toBe(true);
  });

  test('an answer of true is loaded, even after the delay ran out', () => {
    expect(
      firstRefreshLoading({ done: true, settled: true, waited: true }),
    ).toBe(false);
  });

  test('a missing flag counts as loaded', () => {
    expect(
      firstRefreshLoading({ done: undefined, settled: true, waited: true }),
    ).toBe(false);
  });

  test('a failed first request settles to the tolerant state', () => {
    expect(
      firstRefreshLoading({ done: undefined, settled: true, waited: true }),
    ).toBe(false);
  });
});

describe('hasTimestamp', () => {
  test('Go zero time is not a timestamp', () => {
    expect(hasTimestamp('0001-01-01T00:00:00Z')).toBe(false);
  });

  test('absent or unparsable is not a timestamp', () => {
    expect(hasTimestamp(undefined)).toBe(false);
    expect(hasTimestamp(null)).toBe(false);
    expect(hasTimestamp('')).toBe(false);
    expect(hasTimestamp('nope')).toBe(false);
  });

  test('a real time is', () => {
    expect(hasTimestamp('2026-10-17T10:00:00Z')).toBe(true);
  });
});

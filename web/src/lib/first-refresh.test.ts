/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  branchesAwaitingFlag,
  FIRST_REFRESH_SLOW_MS,
  firstRefreshPending,
  firstRefreshStatus,
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

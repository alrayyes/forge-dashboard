/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import {
  applyServerState,
  hasTouched,
  loadState,
  loadStateFromServer,
  releaseAllHeld,
  type SharedFilterState,
  saveState,
  touchKey,
} from './filters';
import {
  DEFAULT_FILTER,
  filterFromState,
  filterToState,
  statusCount,
} from './main-branches';

// The Branches filter rides in the same saved copy as the other pages' filters
// (#1620): the cookie for the first paint, the server copy for a second
// browser. https://github.com/alrayyes/forge-dashboard/issues/1620

const fakeDoc = { cookie: '' };
const realFetch = globalThis.fetch;
let puts: SharedFilterState[] = [];

beforeEach(() => {
  releaseAllHeld();
  jest.useFakeTimers();
  Object.assign(globalThis, { document: fakeDoc });
  fakeDoc.cookie = '';
  puts = [];
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    puts.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

describe('the Branches filter as saved state', () => {
  test('a filter round-trips through its saved form', () => {
    const filter = {
      status: 'failed',
      forge: 'forgejo',
      advisories: 'has',
      query: 'Wiki',
    } as const;
    expect(filterFromState(filterToState(filter))).toEqual(filter);
  });

  test('nothing saved reads as the default filter', () => {
    expect(filterFromState(undefined)).toEqual(DEFAULT_FILTER);
    expect(filterFromState({})).toEqual(DEFAULT_FILTER);
  });

  test('the cancelled status is kept, not reset to its default (#1950)', () => {
    expect(filterFromState({ status: 'cancelled' }).status).toBe('cancelled');
  });

  test('the awaiting approval status is kept, not reset to its default (#2024)', () => {
    expect(filterFromState({ status: 'awaiting_approval' }).status).toBe(
      'awaiting_approval',
    );
  });

  test('a status pill reads its own count, awaiting approval from awaitingApproval (#2024)', () => {
    const counts = {
      failed: 0,
      passed: 3,
      running: 4,
      cancelled: 0,
      awaitingApproval: 1,
      none: 0,
      total: 8,
    };
    expect(statusCount(counts, 'awaiting_approval')).toBe(1);
    expect(statusCount(counts, 'running')).toBe(4);
    expect(statusCount(counts, 'all')).toBe(8);
  });

  test('a stale or hand-edited value reads as its default', () => {
    expect(
      filterFromState({ status: 'bogus', forge: 'svn', query: 'x' }),
    ).toEqual({ status: 'all', forge: 'all', advisories: 'all', query: 'x' });
  });

  test('the advisories choice is kept, and a stale one reads as any', () => {
    expect(filterFromState({ advisories: 'has' }).advisories).toBe('has');
    expect(filterFromState({ advisories: 'none' }).advisories).toBe('none');
    expect(filterFromState({ advisories: 'some' }).advisories).toBe('all');
    expect(filterFromState({}).advisories).toBe('all');
  });

  test('a query is kept as typed, mixed case included, up to 200 characters', () => {
    expect(filterFromState({ query: 'Ryan' }).query).toBe('Ryan');
    expect(filterFromState({ query: 'a'.repeat(300) }).query).toHaveLength(200);
  });
});

describe('saving and restoring it', () => {
  const base = (): SharedFilterState => ({
    shared: {},
    pr: {},
    issue: {},
    view: {},
    branches: filterToState({
      status: 'failed',
      forge: 'github',
      advisories: 'all',
      query: 'api',
    }),
  });

  test('saveState writes it to the cookie and to the server copy', () => {
    saveState(base());
    expect(loadState().branches).toEqual({
      status: 'failed',
      forge: 'github',
      query: 'api',
    });
    expect(puts).toHaveLength(1);
    expect(puts[0].branches?.status).toBe('failed');
  });

  test('another page saving does not drop it', () => {
    const state = loadState();
    state.branches = { status: 'passed' };
    state.pr.title = 'fix';
    saveState(state);
    expect(puts[0].branches).toEqual({ status: 'passed' });
  });

  test('the server copy fills a state whose cookie was empty', () => {
    const state = loadState();
    expect(state.branches).toEqual({});
    applyServerState(state, { branches: { status: 'running', query: 'x' } });
    expect(filterFromState(state.branches)).toEqual({
      status: 'running',
      forge: 'all',
      advisories: 'all',
      query: 'x',
    });
  });

  test('a server copy holding only Branches filters counts as a copy', async () => {
    globalThis.fetch = ((_url: string) =>
      Promise.resolve(
        new Response(JSON.stringify({ branches: { status: 'failed' } })),
      )) as typeof fetch;
    expect(await loadStateFromServer()).toEqual({
      branches: { status: 'failed' },
    });
  });
});

describe('a Branches key the user touched', () => {
  test('keeps its value over a late copy, the other keys take the copy', () => {
    const state = loadState();
    state.branches = { status: 'passed' };
    touchKey('branches', 'status');
    expect(hasTouched()).toBe(true);
    applyServerState(state, {
      branches: { status: 'failed', forge: 'forgejo' },
    });
    expect(state.branches).toEqual({ status: 'passed', forge: 'forgejo' });
  });
});

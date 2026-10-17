/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import {
  loadState,
  loadStateFromServer,
  releaseAllHeld,
  saveState,
} from './filters';

// A saved state carries a revision that grows on every save, in the cookie and
// in the server copy. On load the copy is applied only when its revision is not
// older than the cookie's, so a typed value is not overwritten by an older copy
// that a slow save left on the server.

const fakeDoc = { cookie: '' };
const realFetch = globalThis.fetch;
let puts: Record<string, unknown>[] = [];
let served: Record<string, unknown> = {};

const cookieRev = (): number => {
  const raw = decodeURIComponent(
    fakeDoc.cookie.match(/forge-board-filters=([^;]*)/)?.[1] ?? '{}',
  );
  return JSON.parse(raw).rev;
};
const setCookieState = (state: Record<string, unknown>) => {
  fakeDoc.cookie = `forge-board-filters=${encodeURIComponent(JSON.stringify(state))}`;
};

beforeEach(() => {
  releaseAllHeld();
  jest.useFakeTimers();
  Object.assign(globalThis, { document: fakeDoc });
  fakeDoc.cookie = '';
  puts = [];
  served = {};
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response(JSON.stringify(served)));
  }) as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

describe('saving stamps a revision', () => {
  test('each save is newer than the last, in the cookie and the copy', () => {
    const state = loadState();
    saveState(state);
    const first = cookieRev();
    expect(typeof first).toBe('number');
    expect(puts[0].rev).toBe(first);
    state.pr.title = 'a';
    saveState(state);
    expect(cookieRev()).toBeGreaterThan(first);
  });

  test('a save after seeing a newer copy goes past it', async () => {
    setCookieState({ rev: 1, shared: {}, pr: {}, issue: {}, view: {} });
    loadState();
    served = { rev: 500, pr: { title: 'x' } };
    await loadStateFromServer();
    saveState(loadState());
    expect(cookieRev()).toBeGreaterThan(500);
  });
});

describe('loading the copy', () => {
  test('a cookie newer than the copy wins, and the copy is brought up to it', async () => {
    setCookieState({
      rev: 9,
      shared: {},
      pr: { title: 'billing' },
      issue: {},
      view: {},
    });
    loadState();
    served = { rev: 8, pr: { title: 'old' } };
    expect(await loadStateFromServer()).toBeNull();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ pr: { title: 'billing' } });
    expect(puts[0].rev as number).toBeGreaterThanOrEqual(9);
  });

  test('a copy newer than the cookie is applied and nothing is sent', async () => {
    setCookieState({ rev: 3, shared: {}, pr: { title: 'old' }, issue: {} });
    loadState();
    served = { rev: 7, pr: { title: 'new' } };
    expect(await loadStateFromServer()).toMatchObject({
      pr: { title: 'new' },
    });
    expect(puts).toHaveLength(0);
  });

  test('equal revisions: the copy wins', async () => {
    setCookieState({ rev: 4, shared: {}, pr: { title: 'a' }, issue: {} });
    loadState();
    served = { rev: 4, pr: { title: 'b' } };
    expect(await loadStateFromServer()).toMatchObject({ pr: { title: 'b' } });
    expect(puts).toHaveLength(0);
  });

  test('a cookie or copy without a revision: the copy wins as before', async () => {
    setCookieState({ shared: {}, pr: { title: 'a' }, issue: {} });
    loadState();
    served = { rev: 2, pr: { title: 'b' } };
    expect(await loadStateFromServer()).toMatchObject({ pr: { title: 'b' } });

    setCookieState({ rev: 6, shared: {}, pr: { title: 'a' }, issue: {} });
    loadState();
    served = { pr: { title: 'b' } };
    expect(await loadStateFromServer()).toMatchObject({ pr: { title: 'b' } });
    expect(puts).toHaveLength(0);
  });
});

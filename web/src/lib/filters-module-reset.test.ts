/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { resetFilterState } from '../test-setup';
import {
  currentPage,
  flushPendingSave,
  loadState,
  loadStateFromServer,
  reconcilePick,
  type SharedFilterState,
  saveState,
  takeAuthorOverflow,
  takeDroppedPicks,
  takeMigratedAuthor,
  takeMigratedStatus,
} from './filters';

// The filters module keeps more than the touched keys and held picks (#4215).
// Each case sets one piece of that state, resets, and asserts it is back at
// its first value through the module's own API, so a test that leaves it set
// cannot change the next one. The preload runs the same reset before each test.

const fakeDoc = { cookie: '' };
const realFetch = globalThis.fetch;
let sent: SharedFilterState[] = [];
let answer: unknown = null;

const typed = (title: string): SharedFilterState => ({
  shared: {},
  pr: { title },
  issue: {},
  view: {},
});
const cookieOf = (value: unknown) => {
  fakeDoc.cookie = `forge-board-filters=${encodeURIComponent(JSON.stringify(value))}`;
};
const revInCookie = (): number =>
  JSON.parse(decodeURIComponent(fakeDoc.cookie.split(/=|;/)[1])).rev;

beforeEach(() => {
  sent = [];
  answer = null;
  jest.useFakeTimers();
  Object.assign(globalThis, { document: fakeDoc });
  fakeDoc.cookie = '';
  // A PUT never settles, so one stays in flight until the reset.
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      sent.push(JSON.parse(String(init.body)));
      return new Promise<Response>(() => {});
    }
    return Promise.resolve(Response.json(answer));
  }) as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

describe('the filters module state, reset between tests', () => {
  test('the revision this browser has seen starts again', () => {
    saveState(typed('a'));
    saveState(typed('b'));
    expect(revInCookie()).toBe(2);
    resetFilterState();
    fakeDoc.cookie = '';
    saveState(typed('c'));
    expect(revInCookie()).toBe(1);
  });

  test('the cookie revision of the loaded page is forgotten', async () => {
    cookieOf({ pr: { title: 'x' }, rev: 5 });
    loadState();
    resetFilterState();
    fakeDoc.cookie = '';
    answer = { pr: { title: 'copy' }, rev: 3 };
    expect(await loadStateFromServer()).toMatchObject({
      pr: { title: 'copy' },
    });
  });

  test('a migrated status is no longer waiting to be reported', () => {
    cookieOf({ pr: { quick: 'failed' } });
    loadState();
    resetFilterState();
    expect(takeMigratedStatus()).toBe(false);
  });

  test('a migrated author and its overflow are no longer waiting', () => {
    const others = Array.from({ length: 19 }, (_, i) => `github:u${i}`);
    const s: SharedFilterState = {
      shared: { author: `${others.join('\n')}\nryan` },
      pr: {},
      issue: {},
      view: {},
    };
    reconcilePick(
      s,
      'author',
      [...others, 'forgejo:ryan', 'github:ryan'],
      true,
    );
    resetFilterState();
    expect(takeMigratedAuthor()).toBe(false);
    expect(takeAuthorOverflow()).toBe(0);
  });

  test('picks cut for size are no longer waiting to be reported', () => {
    const many = Array.from({ length: 25 }, (_, i) => `l${i}`).join('\n');
    cookieOf({ shared: { label: many } });
    loadState();
    resetFilterState();
    expect(takeDroppedPicks()).toEqual([]);
  });

  test('a save in flight and the one queued behind it are gone', () => {
    saveState(typed('first'));
    saveState(typed('second'));
    expect(sent).toHaveLength(1);
    resetFilterState();
    flushPendingSave();
    expect(sent).toHaveLength(1);
    saveState(typed('third'));
    expect(sent).toHaveLength(2);
  });

  test('a title save waiting on its timer never fires', () => {
    saveState(typed('typing'), 'title');
    resetFilterState();
    jest.advanceTimersByTime(5000);
    flushPendingSave();
    expect(sent).toHaveLength(0);
  });

  test('the page counter starts again', () => {
    loadState();
    loadState();
    expect(currentPage()).toBeGreaterThan(0);
    resetFilterState();
    expect(currentPage()).toBe(0);
  });
});

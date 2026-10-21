/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  applyServerState,
  holdStale,
  loadState,
  releaseAllHeld,
  releaseHeld,
  type SharedFilterState,
  saveState,
} from './filters';

// A pick the page does not offer is cleared on that page only and stays in the
// saved copy, so the page that does offer it finds it set (#1620). saveState
// writes a cookie and a PUT, so both are stubbed here.
// https://github.com/alrayyes/forge-dashboard/issues/1620

let puts: SharedFilterState[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  puts = [];
  releaseAllHeld();
  Object.assign(globalThis, { document: { cookie: '' } });
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    puts.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  releaseAllHeld();
});

function stateWith(author: string): SharedFilterState {
  return { shared: { author }, pr: {}, issue: {}, view: {} };
}

describe('holdStale', () => {
  test('clears the pick in state but saves it', () => {
    const state = stateWith('ryan');
    holdStale(state, 'shared', 'author');
    expect(state.shared.author).toBe('');

    saveState(state);
    expect(puts.at(-1)?.shared.author).toBe('ryan');
    expect(loadState().shared.author).toBe('ryan');
  });

  test('a pick the user changed afterwards is saved as it is', () => {
    const state = stateWith('ryan');
    holdStale(state, 'shared', 'author');
    releaseHeld('shared', 'author');
    state.shared.author = 'claude';

    saveState(state);
    expect(puts.at(-1)?.shared.author).toBe('claude');
  });

  test('choosing nothing ends the hold instead of bringing the pick back', () => {
    const state = stateWith('ryan');
    holdStale(state, 'shared', 'author');
    releaseHeld('shared', 'author');

    saveState(state);
    expect(puts.at(-1)?.shared.author).toBe('');
  });

  test('a value that was never set is not held', () => {
    const state = stateWith('');
    holdStale(state, 'shared', 'author');

    saveState(state);
    expect(puts.at(-1)?.shared.author).toBe('');
  });
});

describe('applyServerState with a held pick', () => {
  test('the server copy that agrees with the held pick leaves it cleared', () => {
    const state = stateWith('ryan');
    holdStale(state, 'shared', 'author');

    applyServerState(state, stateWith('ryan'));
    expect(state.shared.author).toBe('');
  });

  test('another device with a different pick wins and ends the hold', () => {
    const state = stateWith('ryan');
    holdStale(state, 'shared', 'author');

    applyServerState(state, stateWith('sam'));
    expect(state.shared.author).toBe('sam');
    saveState(state);
    expect(puts.at(-1)?.shared.author).toBe('sam');
  });

  test('still merges key by key, keeping what the server did not mention', () => {
    const state: SharedFilterState = {
      shared: { repo: 'github:a/b' },
      pr: {},
      issue: { hideDependencyDashboard: '1' },
      view: {},
    };
    applyServerState(state, { shared: { author: 'sam' } });
    expect(state.shared).toEqual({ repo: 'github:a/b', author: 'sam' });
    expect(state.issue.hideDependencyDashboard).toBe('1');
  });
});

describe('applyServerState with a closing-link choice', () => {
  const empty = (): SharedFilterState => ({
    shared: {},
    pr: {},
    issue: {},
    view: {},
  });

  test('a saved value other than yes or no reads as Any', () => {
    const state = empty();
    applyServerState(state, {
      pr: { closes: 'maybe' },
      issue: { closedBy: 'maybe' },
    });
    expect(state.pr.closes).toBeUndefined();
    expect(state.issue.closedBy).toBeUndefined();
  });

  test('yes and no are kept', () => {
    const state = empty();
    applyServerState(state, {
      pr: { closes: 'yes' },
      issue: { closedBy: 'no' },
    });
    expect(state.pr.closes).toBe('yes');
    expect(state.issue.closedBy).toBe('no');
  });
});

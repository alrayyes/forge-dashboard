/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  activePill,
  loadState,
  PILL_GROUP_NAMES,
  PILL_GROUPS,
  readCookieState,
  releaseAllHeld,
  type SharedFilterState,
  saveState,
  setPill,
} from './filters';

// Every remembered control is saved to the filter cookie and read back by the
// next page. The journey spec used to prove that for each control in a browser;
// this proves the cookie half for all of them at once, in the exact shapes the
// controls store, so the spec needs only one round trip through a browser.

let jar = '';
const realFetch = globalThis.fetch;

beforeEach(() => {
  jar = '';
  releaseAllHeld();
  Object.assign(globalThis, {
    document: {
      get cookie() {
        return jar;
      },
      set cookie(v: string) {
        jar = v.split(';')[0];
      },
    },
  });
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(null, { status: 204 }),
    )) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  releaseAllHeld();
});

const blank = (): SharedFilterState => ({
  shared: {},
  pr: {},
  issue: { hideDependencyDashboard: '1' },
  view: {},
  branches: {},
  webhooks: {},
});

describe('the filter cookie round trip', () => {
  for (const group of PILL_GROUP_NAMES) {
    for (const pill of PILL_GROUPS[group]) {
      test(`the ${pill} pill comes back as the active ${group} pill`, () => {
        const state = blank();
        setPill(state, group, pill);
        saveState(state);
        const back = loadState();
        expect(activePill(back, group)).toBe(pill);
        for (const other of PILL_GROUP_NAMES)
          if (other !== group) expect(activePill(back, other)).toBe('all');
      });
    }
  }

  test('a pill is saved where the server copy and other tabs look for it', () => {
    const state = blank();
    for (const group of PILL_GROUP_NAMES)
      setPill(state, group, PILL_GROUPS[group][0]);
    saveState(state);
    const saved = JSON.parse(
      decodeURIComponent(jar.slice(jar.indexOf('=') + 1)),
    );
    expect(saved.shared.forge).toBe('github');
    expect(saved.pr).toEqual({
      ci: 'failing',
      merge: 'conflicting',
      review: 'ready',
    });
  });

  test('one pill in every group comes back together', () => {
    const state = blank();
    for (const group of PILL_GROUP_NAMES)
      setPill(state, group, PILL_GROUPS[group][0]);
    saveState(state);
    const back = loadState();
    for (const group of PILL_GROUP_NAMES)
      expect(activePill(back, group)).toBe(PILL_GROUPS[group][0]);
  });

  test('every other control comes back under the group and key it was saved to', () => {
    const state: SharedFilterState = {
      shared: {
        repo: 'forgejo:acme/infra',
        author: 'forgejo:dana',
        label: 'bug',
        created: '1440',
        updated: '1440',
        groupBy: 'repo',
        title: 'pull',
      },
      pr: { autoMerge: 'off' },
      // Off is an empty string, and must not fall back to the default of on.
      issue: { hideDependencyDashboard: '', hideTitleRegex: '^zzz' },
      view: { sort: 'created', paused: '1', drafts: '1' },
      branches: {},
      webhooks: {
        forge: 'forgejo',
        repo: 'infra',
        status: 'pending',
        sort: 'hasWebhook',
        dir: 'asc',
      },
    };
    saveState(state);
    expect(readCookieState()).toEqual(state);
  });

  test('a pick with several values keeps them apart', () => {
    const state = blank();
    state.shared.repo = 'github:acme/app\nforgejo:acme/infra';
    saveState(state);
    expect(readCookieState().shared.repo).toBe(state.shared.repo);
  });

  test('the cookie value is URL-encoded JSON that carries the revision', () => {
    const state = blank();
    state.shared.title = 'a; b=c';
    saveState(state);
    const value = jar.slice(jar.indexOf('=') + 1);
    expect(value).not.toContain(';');
    const parsed = JSON.parse(decodeURIComponent(value));
    expect(parsed.shared.title).toBe('a; b=c');
    expect(typeof parsed.rev).toBe('number');
  });
});

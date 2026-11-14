/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  releaseHeldPick,
  saveWebhooksFilter,
  setHideDependencyDashboard,
  setSharedControl,
} from './filter-wiring';
import {
  applyServerState,
  heldPicks,
  holdStale,
  releaseAllHeld,
  resetTouched,
  type SharedFilterState,
  saveState,
} from './filters';
import { DEFAULT_WEBHOOKS_FILTER } from './webhooks-filter';

// Each control marks the key it changed as touched, so a saved copy still
// loading cannot overwrite it (#1713). Every test changes one control, then
// lets a server copy that disagrees arrive: the change must win. These stand
// in for the Webhooks end-to-end test of the same behaviour (#3862).
// https://github.com/alrayyes/forge-dashboard/issues/1713

const state = (over: Partial<SharedFilterState> = {}): SharedFilterState => ({
  shared: {},
  pr: {},
  issue: {},
  view: {},
  ...over,
});

const realFetch = globalThis.fetch;
let puts: unknown[] = [];

beforeEach(() => {
  puts = [];
  resetTouched();
  releaseAllHeld();
  Object.assign(globalThis, { document: { cookie: '' } });
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    puts.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetTouched();
  releaseAllHeld();
});

describe('setSharedControl', () => {
  test('keeps the typed value over a saved copy, and the rest takes the copy', () => {
    const s = state();
    setSharedControl(s, 'title', 'issue 1');
    applyServerState(s, { shared: { title: 'issue', label: 'bug' } });
    expect(s.shared.title).toBe('issue 1');
    expect(s.shared.label).toBe('bug');
  });

  test('lets go of a pick held for the control', () => {
    const s = state({ shared: { author: 'github:ann' } });
    holdStale(s, 'shared', 'author');
    expect(heldPicks()).toHaveLength(1);
    setSharedControl(s, 'author', '');
    expect(heldPicks()).toHaveLength(0);
  });
});

describe('setHideDependencyDashboard', () => {
  test('keeps an unticked box over a saved copy that has it ticked', () => {
    const s = state({ issue: { hideDependencyDashboard: '1' } });
    setHideDependencyDashboard(s, false);
    applyServerState(s, { issue: { hideDependencyDashboard: '1' } });
    expect(s.issue.hideDependencyDashboard).toBe('');
  });

  test('stores a ticked box as 1', () => {
    const s = state();
    setHideDependencyDashboard(s, true);
    expect(s.issue.hideDependencyDashboard).toBe('1');
  });
});

describe('releaseHeldPick', () => {
  test('drops the pick, keeps it dropped over the copy, saves, and lists what is left', () => {
    const s = state({ shared: { author: 'github:ann', repo: 'github:a/b' } });
    holdStale(s, 'shared', 'author');
    holdStale(s, 'shared', 'repo');
    const [first] = heldPicks();
    const left = releaseHeldPick(s, first);
    expect(left).toHaveLength(1);
    expect(left[0].key).not.toBe(first.key);
    applyServerState(s, { shared: { [first.key]: 'github:zed' } });
    expect(s.shared[first.key]).toBe('');
    expect(puts).toHaveLength(1);
  });
});

describe('saveWebhooksFilter', () => {
  test('keeps the changed status over a saved copy, the repo search takes the copy', () => {
    const saved = state({ webhooks: {} });
    const next = saveWebhooksFilter(
      saved,
      { ...DEFAULT_WEBHOOKS_FILTER, status: 'pending' },
      ['status'],
    );
    applyServerState(next, { webhooks: { repo: 'acme', status: 'confirmed' } });
    expect(next.webhooks?.status).toBe('pending');
    expect(next.webhooks?.repo).toBe('acme');
  });

  test('starts from what another tab saved to the shared cookie', () => {
    const jar: Record<string, string> = {};
    Object.defineProperty(globalThis.document, 'cookie', {
      configurable: true,
      get: () =>
        Object.entries(jar)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      set: (v: string) => {
        const [pair] = v.split(';');
        const at = pair.indexOf('=');
        jar[pair.slice(0, at)] = pair.slice(at + 1);
      },
    });
    saveState({ ...state(), shared: { label: 'bug' } });
    const next = saveWebhooksFilter(
      state({ webhooks: {} }),
      { ...DEFAULT_WEBHOOKS_FILTER, repo: 'acme' },
      ['repo'],
    );
    expect(next.shared.label).toBe('bug');
  });

  test('saves the filter under the webhooks group', () => {
    saveWebhooksFilter(
      state({ webhooks: {} }),
      { ...DEFAULT_WEBHOOKS_FILTER, repo: 'acme' },
      ['repo'],
    );
    expect((puts.at(-1) as SharedFilterState).webhooks?.repo).toBe('acme');
  });
});

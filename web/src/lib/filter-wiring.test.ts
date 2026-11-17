/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  clearFilterFor,
  releaseHeldPick,
  resetFilters,
  saveWebhooksControl,
  saveWebhooksFilter,
  setDrafts,
  setGroupBy,
  setHideDependencyDashboard,
  setHideTitleRegex,
  setPaused,
  setQuickPill,
  setSegment,
  setSharedControl,
  setSort,
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

describe('setHideTitleRegex', () => {
  test('keeps the typed pattern over a saved copy with another', () => {
    const s = state({ issue: { hideTitleRegex: 'qqq' } });
    setHideTitleRegex(s, 'zzz');
    applyServerState(s, { issue: { hideTitleRegex: 'qqq' } });
    expect(s.issue.hideTitleRegex).toBe('zzz');
  });
});

describe('the view and layout controls', () => {
  test('pausing keeps the choice over a saved copy', () => {
    const s = state();
    setPaused(s, true);
    applyServerState(s, { view: { paused: '' } });
    expect(s.view.paused).toBe('1');
  });

  test('resuming keeps the choice over a saved copy', () => {
    const s = state({ view: { paused: '1' } });
    setPaused(s, false);
    applyServerState(s, { view: { paused: '1' } });
    expect(s.view.paused).toBe('');
  });

  test('the drafts choice wins over a saved copy', () => {
    const s = state();
    setDrafts(s, true);
    applyServerState(s, { view: { drafts: '' } });
    expect(s.view.drafts).toBe('1');
  });

  test('the grouping wins over a saved copy', () => {
    const s = state();
    setGroupBy(s, 'repo');
    applyServerState(s, { shared: { groupBy: 'forge' } });
    expect(s.shared.groupBy).toBe('repo');
  });

  test('the sort wins over a saved copy', () => {
    const s = state();
    setSort(s, 'oldest');
    applyServerState(s, { view: { sort: 'newest' } });
    expect(s.view.sort).toBe('oldest');
  });
});

describe('setQuickPill', () => {
  test('a forge pill is kept with the shared controls and wins over a saved copy', () => {
    const s = state();
    setQuickPill(s, 'forge', 'github');
    applyServerState(s, { shared: { forge: 'forgejo' } });
    expect(s.shared.forge).toBe('github');
  });

  test('a CI pill is kept with the pull request controls and wins over a saved copy', () => {
    const s = state();
    setQuickPill(s, 'ci', 'failing');
    applyServerState(s, { pr: { ci: 'passing' } });
    expect(s.pr.ci).toBe('failing');
  });
});

describe('setSegment', () => {
  test('a pull request choice wins over a saved copy', () => {
    const s = state();
    setSegment(s, 'pr', 'autoMerge', 'on');
    applyServerState(s, { pr: { autoMerge: 'off' } });
    expect(s.pr.autoMerge).toBe('on');
  });

  test('Any removes the key and keeps it removed over a saved copy', () => {
    const s = state({ issue: { refs: 'yes' } });
    setSegment(s, 'issue', 'refs', 'any');
    expect(s.issue.refs).toBeUndefined();
    applyServerState(s, { issue: { refs: 'yes' } });
    expect(s.issue.refs).toBeUndefined();
  });
});

describe('clearFilterFor', () => {
  test('empties the filter, keeps it empty over the copy, and lets go of a held pick', () => {
    const s = state({ shared: { created: '7d' } });
    holdStale(s, 'shared', 'created');
    clearFilterFor(s, 'shared', 'created');
    expect(heldPicks()).toHaveLength(0);
    applyServerState(s, { shared: { created: '30d' } });
    expect(s.shared.created).toBe('');
  });
});

describe('resetFilters', () => {
  const settings = { hideDependencyDashboard: false, ignoreTitles: false };

  test('empties every group in place, so the boards keep their objects', () => {
    const s = state({
      shared: { label: 'bug' },
      pr: { ci: 'failing' },
      issue: { hideTitleRegex: 'x' },
    });
    const { shared, pr, issue } = s;
    resetFilters(s, settings);
    expect(s.shared).toBe(shared);
    expect(s.pr).toBe(pr);
    expect(s.issue).toBe(issue);
    expect(shared).toEqual({});
    expect(pr).toEqual({});
    expect(issue).toEqual({ hideDependencyDashboard: '1' });
  });

  test('is not undone by a saved copy that arrives afterwards', () => {
    const s = state({ shared: { label: 'bug' }, pr: { ci: 'failing' } });
    resetFilters(s, settings);
    applyServerState(s, {
      shared: { label: 'bug' },
      pr: { ci: 'failing' },
      issue: { hideDependencyDashboard: '' },
    });
    expect(s.shared.label).toBeUndefined();
    expect(s.pr.ci).toBeUndefined();
    expect(s.issue.hideDependencyDashboard).toBe('1');
  });

  test('lets go of every held pick', () => {
    const s = state({ shared: { author: 'github:ann' } });
    holdStale(s, 'shared', 'author');
    resetFilters(s, settings);
    expect(heldPicks()).toHaveLength(0);
  });

  test('keeps the saved dashboard box and title pattern a setting replaced', () => {
    const s = state({
      issue: { hideDependencyDashboard: '', hideTitleRegex: 'qqq' },
    });
    resetFilters(s, { hideDependencyDashboard: true, ignoreTitles: true });
    expect(s.issue.hideDependencyDashboard).toBe('');
    expect(s.issue.hideTitleRegex).toBe('qqq');
  });

  test('puts the box back on and drops the pattern when no setting replaces them', () => {
    const s = state({
      issue: { hideDependencyDashboard: '', hideTitleRegex: 'qqq' },
    });
    resetFilters(s, settings);
    expect(s.issue.hideDependencyDashboard).toBe('1');
    expect(s.issue.hideTitleRegex).toBeUndefined();
  });
});

describe('saveWebhooksControl', () => {
  const filter = { ...DEFAULT_WEBHOOKS_FILTER };
  const wins = (control: Parameters<typeof saveWebhooksControl>[2]) => {
    const next = saveWebhooksControl(
      state({ webhooks: {} }),
      {
        ...filter,
        forge: 'github',
        repo: 'acme',
        status: 'pending',
        sort: 'forge',
        dir: 'desc',
      },
      control,
    );
    applyServerState(next, {
      webhooks: {
        forge: 'forgejo',
        repo: 'zed',
        status: 'confirmed',
        sort: 'fullName',
        dir: 'asc',
      },
    });
    return next.webhooks ?? {};
  };

  test('the forge control owns the forge key only', () => {
    const w = wins('forge');
    expect(w.forge).toBe('github');
    expect(w.repo).toBe('zed');
    expect(w.status).toBe('confirmed');
  });

  test('the repo control owns the repo key only', () => {
    const w = wins('repo');
    expect(w.repo).toBe('acme');
    expect(w.forge).toBe('forgejo');
  });

  test('the status control owns the status key only', () => {
    const w = wins('status');
    expect(w.status).toBe('pending');
    expect(w.forge).toBe('forgejo');
  });

  test('the sort control owns the sort and direction', () => {
    const w = wins('sort');
    expect(w.sort).toBe('forge');
    expect(w.dir).toBe('desc');
    expect(w.repo).toBe('zed');
  });

  test('clearing owns every key', () => {
    const w = wins('clear');
    expect([w.forge, w.repo, w.status, w.sort, w.dir]).toEqual([
      'github',
      'acme',
      'pending',
      'forge',
      'desc',
    ]);
  });

  test('the repo box waits for a pause in typing, the others save at once', () => {
    saveWebhooksControl(state({ webhooks: {} }), filter, 'repo');
    expect(puts).toHaveLength(0);
    saveWebhooksControl(state({ webhooks: {} }), filter, 'status');
    expect(puts).toHaveLength(1);
  });
});

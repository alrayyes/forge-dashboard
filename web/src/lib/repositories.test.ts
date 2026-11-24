/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { registerForgeCapabilities, resetForgeCapabilities } from './forges';
import {
  autoUpdateName,
  bulkTargets,
  filterRepos,
  filtersAreClear,
  forgeChoices,
  ignoreName,
  type RepoRow,
  rebaseBotsName,
  sortRepos,
} from './repositories';

function repo(
  forge: string,
  fullName: string,
  extra: Partial<RepoRow> = {},
): RepoRow {
  return {
    forge,
    fullName,
    ignored: false,
    autoUpdateBranch: false,
    rebaseBots: false,
    ...extra,
  };
}

const rows = [
  repo('github', 'demo/api'),
  repo('github', 'demo/web', { ignored: true }),
  repo('forgejo', 'sandbox/infra'),
  repo('forgejo', 'sandbox/API-docs'),
];

afterEach(() => resetForgeCapabilities());

describe('filtering the repositories', () => {
  const none = { forge: '', search: '' };

  test('no filter keeps every repo that is not ignored', () => {
    expect(filterRepos(rows, none).map((r) => r.fullName)).toEqual([
      'demo/api',
      'sandbox/infra',
      'sandbox/API-docs',
    ]);
  });

  test('a forge keeps that forge only', () => {
    expect(
      filterRepos(rows, { ...none, forge: 'forgejo' }).map((r) => r.fullName),
    ).toEqual(['sandbox/infra', 'sandbox/API-docs']);
  });

  test('the search matches any part of the name, ignoring case', () => {
    expect(
      filterRepos(rows, { ...none, search: 'api' }).map((r) => r.fullName),
    ).toEqual(['demo/api', 'sandbox/API-docs']);
  });

  test('forge and search are ANDed', () => {
    expect(
      filterRepos(rows, { forge: 'forgejo', search: 'api' }).map(
        (r) => r.fullName,
      ),
    ).toEqual(['sandbox/API-docs']);
  });

  test('clear means no forge and an empty search', () => {
    expect(filtersAreClear(none)).toBe(true);
    expect(filtersAreClear({ forge: 'github', search: '' })).toBe(false);
    expect(filtersAreClear({ forge: '', search: 'x' })).toBe(false);
  });
});

describe('the forge choices', () => {
  test('offer only forges that survive the search, and keep the picked one', () => {
    registerForgeCapabilities([
      { forge: 'github', reachable: true },
      { forge: 'forgejo', reachable: true },
    ] as never);
    const found = forgeChoices(rows, { forge: '', search: 'infra' });
    expect([...found]).toEqual(['forgejo']);
    expect([
      ...forgeChoices(rows, { forge: 'github', search: 'infra' }),
    ]).toEqual(['github', 'forgejo']);
  });
});

describe('sorting', () => {
  test('by repo, either way', () => {
    const asc = sortRepos(rows, 'fullName', 'asc').map((r) => r.fullName);
    expect(asc[0]).toBe('demo/api');
    expect(sortRepos(rows, 'fullName', 'desc').map((r) => r.fullName)).toEqual(
      asc.slice().reverse(),
    );
  });

  test('by forge keeps the name order inside a forge', () => {
    expect(sortRepos(rows, 'forge', 'asc').map((r) => r.forge)).toEqual([
      'forgejo',
      'forgejo',
      'github',
      'github',
    ]);
  });
});

describe('names an icon button keeps whatever its state', () => {
  test('one fixed name per control', () => {
    expect(autoUpdateName('demo/api')).toBe('Auto-update on demo/api');
    expect(rebaseBotsName('demo/api')).toBe('Rebase bots on demo/api');
    expect(ignoreName('demo/api')).toBe('Ignore demo/api');
  });
});

describe('what a bulk button reaches', () => {
  test('auto-update on reaches repos with it off, and off those with it on', () => {
    const list = [
      repo('github', 'a', { autoUpdateBranch: true }),
      repo('github', 'b'),
      repo('github', 'c', { ignored: true }),
    ];
    expect(bulkTargets(list, 'autoUpdate', true, () => null)).toEqual([
      list[1],
    ]);
    expect(bulkTargets(list, 'autoUpdate', false, () => null)).toEqual([
      list[0],
    ]);
  });

  test('a locked repo is skipped when turning rebase bots on, not off', () => {
    const list = [
      repo('github', 'a', { rebaseBots: true }),
      repo('github', 'b'),
    ];
    const lock = (r: RepoRow) => (r.fullName === 'b' ? 'needs a token' : null);
    expect(bulkTargets(list, 'rebaseBots', true, lock)).toEqual([]);
    expect(bulkTargets(list, 'rebaseBots', false, lock)).toEqual([list[0]]);
  });
});

describe('the polling-only filter (#4028)', () => {
  const polling = [
    repo('github', 'demo/live', { hasWebhook: true }),
    repo('github', 'demo/poll', { hasWebhook: false }),
    repo('forgejo', 'sandbox/poll', { hasWebhook: false }),
    repo('forgejo', 'sandbox/ignored', { hasWebhook: false, ignored: true }),
  ];
  const on = { forge: '', search: '', pollingOnly: true };

  test('keeps only repos without a hook', () => {
    expect(filterRepos(polling, on).map((r) => r.fullName)).toEqual([
      'demo/poll',
      'sandbox/poll',
    ]);
  });
  test('is ANDed with the forge and the search', () => {
    expect(
      filterRepos(polling, { ...on, forge: 'forgejo' }).map((r) => r.fullName),
    ).toEqual(['sandbox/poll']);
    expect(filterRepos(polling, { ...on, search: 'live' })).toEqual([]);
  });
  test('counts as a filter that Clear filters undoes', () => {
    expect(filtersAreClear(on)).toBe(false);
    expect(filtersAreClear({ forge: '', search: '', pollingOnly: false })).toBe(
      true,
    );
  });
  test('a missing flag means off', () => {
    expect(filtersAreClear({ forge: '', search: '' })).toBe(true);
  });
});

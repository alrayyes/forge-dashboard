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
  ignoreScopeOf,
  ignoreScopeWords,
  ignoreTip,
  lockedTip,
  type RepoRow,
  rebaseBotsName,
  repoCountText,
  repoScope,
  sortRepos,
  toggleTip,
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

describe('tooltips', () => {
  test('a toggle tip names the control, its state and what a press does', () => {
    expect(toggleTip('Auto-update', true)).toBe(
      'Auto-update: on. Press to turn off',
    );
    expect(toggleTip('Rebase bots', false)).toBe(
      'Rebase bots: off. Press to turn on',
    );
  });
  test('a locked toggle says it is locked, not that a press turns it on', () => {
    expect(lockedTip('Rebase bots')).toBe(
      'Rebase bots: off, locked. The reason is below',
    );
  });
  test('the Ignore tip says what is ignored and what the control offers', () => {
    expect(ignoreTip('')).toBe('Ignore: off. Choose what to ignore');
    expect(ignoreTip('prs')).toBe(
      'Ignore: pull requests. Choose another scope, or turn it off',
    );
    expect(ignoreTip('issues')).toBe(
      'Ignore: issues. Choose another scope, or turn it off',
    );
    expect(ignoreTip('both')).toBe(
      'Ignore: pull requests and issues. Choose another scope, or turn it off',
    );
  });
});

describe('the ignore scope of a row', () => {
  test('is read from the two flags the dashboard read carries', () => {
    expect(ignoreScopeOf({ ignored: false })).toBe('');
    expect(
      ignoreScopeOf({ ignored: true, ignoredPRs: true, ignoredIssues: false }),
    ).toBe('prs');
    expect(
      ignoreScopeOf({ ignored: true, ignoredPRs: false, ignoredIssues: true }),
    ).toBe('issues');
    expect(
      ignoreScopeOf({ ignored: true, ignoredPRs: true, ignoredIssues: true }),
    ).toBe('both');
  });
  test('is said in words on the row', () => {
    expect(ignoreScopeWords('')).toBe('');
    expect(ignoreScopeWords('prs')).toBe('Ignored: pull requests');
    expect(ignoreScopeWords('issues')).toBe('Ignored: issues');
    expect(ignoreScopeWords('both')).toBe('Ignored: pull requests and issues');
  });
});

describe('the ignored filter', () => {
  const none = { forge: '', search: '' };
  const names = (r: RepoRow[]) => r.map((x) => x.fullName);

  test('active hides ignored repos and is the default', () => {
    expect(names(filterRepos(rows, { ...none, ignored: 'active' }))).toEqual(
      names(filterRepos(rows, none)),
    );
  });
  test('all shows ignored and active repos together', () => {
    expect(names(filterRepos(rows, { ...none, ignored: 'all' }))).toEqual([
      'demo/api',
      'demo/web',
      'sandbox/infra',
      'sandbox/API-docs',
    ]);
  });
  test('only shows the ignored repos', () => {
    expect(names(filterRepos(rows, { ...none, ignored: 'only' }))).toEqual([
      'demo/web',
    ]);
  });
  test('a repo just ignored stays while its key is kept', () => {
    const keep = new Set(['github:demo/web']);
    expect(names(filterRepos(rows, none, keep))).toContain('demo/web');
  });
  test('a kept repo still obeys the forge and search filters', () => {
    const keep = new Set(['github:demo/web']);
    expect(
      names(filterRepos(rows, { ...none, forge: 'forgejo' }, keep)),
    ).not.toContain('demo/web');
    expect(
      names(filterRepos(rows, { ...none, search: 'infra' }, keep)),
    ).toEqual(['sandbox/infra']);
  });
  test('a kept repo that is active drops out of the ignored-only view', () => {
    const keep = new Set(['github:demo/api']);
    expect(
      names(filterRepos(rows, { ...none, ignored: 'only' }, keep)),
    ).toEqual(['demo/api', 'demo/web']);
  });
  test('a non-default choice is a filter that Clear filters can undo', () => {
    expect(filtersAreClear({ ...none, ignored: 'all' })).toBe(false);
    expect(filtersAreClear({ ...none, ignored: 'active' })).toBe(true);
  });
});

describe('the Auto-update and Rebase bots filters', () => {
  const none = { forge: '', search: '' };
  const list = [
    repo('github', 'a', { autoUpdateBranch: true, rebaseBots: true }),
    repo('github', 'b', { autoUpdateBranch: true }),
    repo('github', 'c', { rebaseBots: true }),
    repo('github', 'd'),
  ];
  const names = (r: RepoRow[]) => r.map((x) => x.fullName);

  test('unset and all keep every repo', () => {
    expect(names(filterRepos(list, none))).toEqual(['a', 'b', 'c', 'd']);
    expect(
      names(
        filterRepos(list, { ...none, autoUpdate: 'all', rebaseBots: 'all' }),
      ),
    ).toEqual(['a', 'b', 'c', 'd']);
  });
  test('Auto-update on and off split the list', () => {
    expect(names(filterRepos(list, { ...none, autoUpdate: 'on' }))).toEqual([
      'a',
      'b',
    ]);
    expect(names(filterRepos(list, { ...none, autoUpdate: 'off' }))).toEqual([
      'c',
      'd',
    ]);
  });
  test('Rebase bots on and off split the list', () => {
    expect(names(filterRepos(list, { ...none, rebaseBots: 'on' }))).toEqual([
      'a',
      'c',
    ]);
    expect(names(filterRepos(list, { ...none, rebaseBots: 'off' }))).toEqual([
      'b',
      'd',
    ]);
  });
  test('they combine with each other, the search and the forge', () => {
    expect(
      names(
        filterRepos(list, { ...none, autoUpdate: 'on', rebaseBots: 'off' }),
      ),
    ).toEqual(['b']);
    expect(
      names(filterRepos(list, { ...none, autoUpdate: 'off', search: 'd' })),
    ).toEqual(['d']);
    expect(
      names(filterRepos(list, { ...none, forge: 'forgejo', autoUpdate: 'on' })),
    ).toEqual([]);
  });
  test('they combine with the ignored view', () => {
    const withIgnored = [...list, repo('github', 'e', { ignored: true })];
    expect(
      names(
        filterRepos(withIgnored, {
          ...none,
          ignored: 'all',
          rebaseBots: 'off',
        }),
      ),
    ).toEqual(['b', 'd', 'e']);
    expect(
      names(filterRepos(withIgnored, { ...none, rebaseBots: 'off' })),
    ).toEqual(['b', 'd']);
  });
  test('a toggled repo stays while its key is kept, others still filter', () => {
    const keep = new Set(['github:a']);
    expect(
      names(filterRepos(list, { ...none, autoUpdate: 'off' }, keep)),
    ).toEqual(['a', 'c', 'd']);
    expect(
      names(
        filterRepos(
          list,
          { ...none, forge: 'forgejo', autoUpdate: 'off' },
          keep,
        ),
      ),
    ).toEqual([]);
  });
  test('a non-default choice is a filter that Clear filters can undo', () => {
    expect(filtersAreClear({ ...none, autoUpdate: 'all' })).toBe(true);
    expect(filtersAreClear({ ...none, autoUpdate: 'on' })).toBe(false);
    expect(filtersAreClear({ ...none, rebaseBots: 'off' })).toBe(false);
  });
});

describe('the repo count', () => {
  test('says how many rows match out of those tracked', () => {
    expect(repoCountText(12, 78)).toBe('Showing 12 of 78 repos');
    expect(repoCountText(78, 78)).toBe('Showing all 78 repos');
    expect(repoCountText(1, 1)).toBe('Showing all 1 repo');
    expect(repoCountText(0, 5)).toBe('Showing 0 of 5 repos');
  });
});

describe('the forge choices under the Auto-update and Rebase bots filters', () => {
  const list = [
    repo('github', 'a'),
    repo('forgejo', 'b', { autoUpdateBranch: true }),
    repo('github', 'c', { rebaseBots: true }),
  ];
  const none = { forge: '', search: '' };

  test('offer only forges with a row the toggles keep', () => {
    registerForgeCapabilities([
      { forge: 'github', reachable: true },
      { forge: 'forgejo', reachable: true },
    ] as never);
    expect([...forgeChoices(list, { ...none, autoUpdate: 'on' })]).toEqual([
      'forgejo',
    ]);
    expect([...forgeChoices(list, { ...none, rebaseBots: 'on' })]).toEqual([
      'github',
    ]);
  });
});

describe('what the repo count counts against', () => {
  const list = [
    repo('github', 'a'),
    repo('github', 'b', { ignored: true }),
    repo('github', 'c'),
  ];
  const none = { forge: '', search: '' };

  test('the default view leaves ignored repos out of the total', () => {
    expect(repoScope(list, none)).toBe(2);
  });
  test('showing or isolating ignored repos counts them', () => {
    expect(repoScope(list, { ...none, ignored: 'all' })).toBe(3);
    expect(repoScope(list, { ...none, ignored: 'only' })).toBe(1);
  });
  test('a kept row counts, so shown never exceeds the total', () => {
    expect(repoScope(list, none, new Set(['github:b']))).toBe(3);
  });
});

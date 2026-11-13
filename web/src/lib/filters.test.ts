/// <reference types="bun" />
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test';
import {
  activePill,
  ageChoices,
  ciBucket,
  effectivePill,
  type FilterableItem,
  failingFilters,
  matchesFilters,
  matchesQuickFilter,
  matchesRefs,
  offerAutoMerge,
  offerDrafts,
  offerPills,
  offerRefs,
  optionPool,
  PILL_GROUPS,
  pillGroupOf,
  QUICK_FILTERS,
  refsChoiceLabel,
  refsChoiceShort,
  refsKey,
  type SharedFilterState,
  setPill,
  showBlockedChip,
} from './filters';

// Which fixed choices a set of items offers (#1427). Pure, so these run without
// a browser; the pages' wiring is in filter-choices-static.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/1427

const MINUTE = 60 * 1000;
// The age choices read the clock, so it is fixed rather than real.
const NOW = Date.parse('2026-10-12T12:00:00Z');

beforeAll(() => setSystemTime(new Date(NOW)));
afterAll(() => setSystemTime());

function choiceItem(overrides: Partial<FilterableItem> = {}): FilterableItem {
  const now = new Date(NOW).toISOString();
  return {
    forge: 'github',
    repo: 'a/app',
    title: 'An item',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const minutesOld = (minutes: number) =>
  new Date(NOW - minutes * MINUTE).toISOString();
const offered = (items: FilterableItem[]) =>
  ageChoices(items, 'createdAt').map((c) => c.value);

describe('ageChoices', () => {
  test('a range is offered when an item is exactly its width old, and not one minute past it', () => {
    for (const [minutes, value] of [
      [60, '60'],
      [1440, '1440'],
      [10080, '10080'],
      [43200, '43200'],
    ] as const) {
      expect(
        offered([choiceItem({ createdAt: minutesOld(minutes) })]),
      ).toContain(value);
      expect(
        offered([choiceItem({ createdAt: minutesOld(minutes + 1) })]),
      ).not.toContain(value);
    }
  });

  test('an offered range always matches something under the filter itself', () => {
    const items = [
      choiceItem({ createdAt: minutesOld(30) }),
      choiceItem({ createdAt: minutesOld(2000) }),
    ];

    for (const value of offered(items)) {
      expect(
        items.some((i) =>
          matchesFilters(i, false, { created: value }, undefined),
        ),
      ).toBe(true);
    }
  });

  test('nothing newer than a month offers no range at all', () => {
    expect(
      offered([choiceItem({ createdAt: minutesOld(60 * 24 * 90) })]),
    ).toEqual([]);
  });

  test('an invalid date is never counted in a range', () => {
    expect(offered([choiceItem({ createdAt: 'not a date' })])).toEqual([]);
  });
});

// Which items a filter's own choices come from (#1427). Pure, so these run
// without a browser; the pages' wiring is in filter-options.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/1427

function optionItem(overrides: Partial<FilterableItem> = {}): FilterableItem {
  const now = new Date(NOW).toISOString();
  return {
    forge: 'github',
    repo: 'a/app',
    title: 'An item',
    author: 'ryan',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const repos = (items: FilterableItem[]) => items.map((i) => i.repo);

describe('optionPool', () => {
  test('keeps what the other filters let through and drops the rest', () => {
    const items = [
      optionItem({ repo: 'a/one', author: 'ryan' }),
      optionItem({ repo: 'a/two', author: 'claude' }),
    ];

    expect(
      repos(optionPool(items, false, { author: 'github:ryan' }, 'repo')),
    ).toEqual(['a/one']);
  });

  test('leaves the filter being populated out, so a picked value keeps its siblings', () => {
    const items = [
      optionItem({ repo: 'a/one' }),
      optionItem({ repo: 'a/two' }),
    ];

    expect(
      repos(optionPool(items, false, { repo: 'github:a/one' }, 'repo')),
    ).toEqual(['a/one', 'a/two']);
    expect(
      repos(optionPool(items, false, { repo: 'github:a/one' }, 'author')),
    ).toEqual(['a/one']);
  });

  test('drops a housekeeping issue while the page hides it, and keeps it once it does not', () => {
    const items = [
      optionItem({ repo: 'a/real' }),
      optionItem({ repo: 'a/dash', housekeeping: true }),
    ];

    expect(
      repos(optionPool(items, false, {}, '', { hideDependencyDashboard: '1' })),
    ).toEqual(['a/real']);
    expect(
      repos(optionPool(items, false, {}, '', { hideDependencyDashboard: '' })),
    ).toEqual(['a/real', 'a/dash']);
    expect(repos(optionPool(items, false, {}, ''))).toEqual([
      'a/real',
      'a/dash',
    ]);
  });

  test('an empty exclude key applies every filter, which the title suggestions want', () => {
    const items = [
      optionItem({ title: 'Fix a bug' }),
      optionItem({ title: 'Add a feature' }),
    ];

    expect(optionPool(items, false, { title: 'bug' }, '')).toHaveLength(1);
  });
});

// The Blocked chip is dropped when CI is failing (#1561): the failing CI pill
// already says why. https://github.com/alrayyes/forge-dashboard/issues/1561
describe('showBlockedChip', () => {
  test('shows for a blocked pull request whose CI passed or has none', () => {
    expect(showBlockedChip('blocked', 'success')).toBe(true);
    expect(showBlockedChip('blocked', 'none')).toBe(true);
    expect(showBlockedChip('blocked', undefined)).toBe(true);
  });

  test('is hidden while CI is failing or still running', () => {
    expect(showBlockedChip('blocked', 'failure')).toBe(false);
    expect(showBlockedChip('blocked', 'pending')).toBe(false);
  });

  test('is never shown for another merge status', () => {
    expect(showBlockedChip('mergeable', 'success')).toBe(false);
    expect(showBlockedChip('conflicting', 'failure')).toBe(false);
    expect(showBlockedChip(undefined, 'success')).toBe(false);
  });
});

// Ready to Merge and Needs Review list what the server says they are (#807):
// the page holds no copy of the definitions. Each item below states the flag
// in a way that disagrees with what its raw fields would have said.
// https://github.com/alrayyes/forge-dashboard/issues/807
describe('matchesQuickFilter follows the server flags', () => {
  const rawReady = choiceItem({
    ci: 'success',
    mergeStatus: 'mergeable',
    readyToMerge: false,
  });
  const rawFailing = choiceItem({
    ci: 'failure',
    mergeStatus: 'blocked',
    draft: true,
    readyToMerge: true,
  });
  const serverReview = choiceItem({
    review: { decision: 'approved', requestedReviewers: 0 },
    needsReview: true,
  });
  const rawReview = choiceItem({
    review: { decision: 'review_required', requestedReviewers: 1 },
    needsReview: false,
  });

  test('ready keeps the items the server marks readyToMerge, whatever the raw fields say', () => {
    expect(matchesQuickFilter(rawFailing, 'ready')).toBe(true);
    expect(matchesQuickFilter(rawReady, 'ready')).toBe(false);
  });

  test('needs-review keeps the items the server marks needsReview, whatever the raw fields say', () => {
    expect(matchesQuickFilter(serverReview, 'needs-review')).toBe(true);
    expect(matchesQuickFilter(rawReview, 'needs-review')).toBe(false);
  });

  test('an item the server did not flag is in neither', () => {
    const bare = choiceItem();
    expect(matchesQuickFilter(bare, 'ready')).toBe(false);
    expect(matchesQuickFilter(bare, 'needs-review')).toBe(false);
  });

  test('review-requested keeps the items the server says ask me, on either forge', () => {
    const github = choiceItem({ reviewRequestedFromMe: true });
    const forgejo = choiceItem({
      forge: 'forgejo',
      repo: 'ryan/infra',
      reviewRequestedFromMe: true,
    });
    expect(matchesQuickFilter(github, 'review-requested')).toBe(true);
    expect(matchesQuickFilter(forgejo, 'review-requested')).toBe(true);
    expect(
      matchesQuickFilter(
        choiceItem({ reviewRequestedFromMe: false }),
        'review-requested',
      ),
    ).toBe(false);
    expect(matchesQuickFilter(choiceItem(), 'review-requested')).toBe(false);
  });
});

// Failing CI lists what the server says is failing (#1946): a pull request
// whose only trouble is a workflow held for approval reads ci "failure" but is
// not failing, the same rule as the menu pill. A server that predates the flag
// leaves it off, and the raw ci answers.
describe('the failing filters follow failingCi', () => {
  const held = choiceItem({ ci: 'failure', failingCi: false });
  const broken = choiceItem({ ci: 'failure', failingCi: true });
  const oldServer = choiceItem({ ci: 'failure' });

  test('the Failing CI quick filter leaves a held pull request out', () => {
    expect(matchesQuickFilter(held, 'failing')).toBe(false);
    expect(matchesQuickFilter(broken, 'failing')).toBe(true);
    expect(matchesQuickFilter(oldServer, 'failing')).toBe(true);
  });

  test('a draft is filtered by its CI like any other row', () => {
    const draft = (ci: string) => choiceItem({ ci, draft: true });
    expect(matchesQuickFilter(draft('failure'), 'failing')).toBe(true);
    expect(matchesQuickFilter(draft('success'), 'failing')).toBe(false);
  });

  test('counts file a held pull request under running, not failing', () => {
    expect(ciBucket(held)).toBe('pending');
    expect(ciBucket(broken)).toBe('failure');
    expect(ciBucket(oldServer)).toBe('failure');
    expect(ciBucket(choiceItem({ ci: 'success' }))).toBe('success');
  });
});

// The No checks pill lists what has no CI (2084). It was the one state the old
// CI status pulldown had and the pills lacked.
describe('the No checks quick filter', () => {
  test('is a quick filter', () => {
    expect(QUICK_FILTERS).toContain('no-checks');
  });

  test('matches a pull request with no CI and nothing else', () => {
    expect(matchesQuickFilter(choiceItem({ ci: 'none' }), 'no-checks')).toBe(
      true,
    );
    for (const ci of ['success', 'failure', 'pending', undefined])
      expect(matchesQuickFilter(choiceItem({ ci }), 'no-checks')).toBe(false);
  });

  test('is offered only while a pull request has no checks, or is picked', () => {
    const noChecks = { dataset: { pill: 'no-checks' }, hidden: false };
    const offered = (pool: FilterableItem[], active: string) => {
      offerPills(
        [noChecks as unknown as HTMLElement],
        pools([], pool),
        actives(active),
      );
      return !noChecks.hidden;
    };
    expect(
      offered([choiceItem({ ci: 'none' }), choiceItem({ ci: 'success' })], ''),
    ).toBe(true);
    expect(offered([choiceItem({ ci: 'success' })], '')).toBe(false);
    expect(offered([choiceItem({ ci: 'success' })], 'no-checks')).toBe(true);
  });

  test('the old CI status key no longer filters', () => {
    expect(
      matchesFilters(
        choiceItem({ ci: 'success' }),
        true,
        {},
        { status: 'failure' },
      ),
    ).toBe(true);
  });
});

// Each group counts its own pool: forge takes `forgePool`, every other group
// `pool`. `active` is the pick of the one group a test is about.
const pools = (forgePool: FilterableItem[], pool: FilterableItem[]) => ({
  forge: forgePool,
  ci: pool,
  merge: pool,
  review: pool,
});
const actives = (pick: string) => ({
  forge: pillGroupOf(pick) === 'forge' ? pick : 'all',
  ci: pillGroupOf(pick) === 'ci' ? pick : 'all',
  merge: pillGroupOf(pick) === 'merge' ? pick : 'all',
  review: pillGroupOf(pick) === 'review' ? pick : 'all',
});

// A pill that matches the whole pool shows what no filter shows, so it is
// hidden unless active, and a pill group with only "All" left is hidden
// (#3669).
describe('offerPills when a pill would change nothing', () => {
  function fakePills(names: string[]) {
    const group = {
      hidden: false,
      dataset: {} as Record<string, string>,
    };
    const pills = names.map((pill) => ({
      dataset: { pill },
      hidden: false,
      parentElement: group,
    }));
    return { group, pills: pills as unknown as HTMLElement[], raw: pills };
  }
  const gh = choiceItem({ forge: 'github', ci: 'success' });
  const fj = choiceItem({ forge: 'forgejo', ci: 'success' });
  const running = choiceItem({ ci: 'pending' });

  test('hides a forge pill when every item is on that forge, keeps both when mixed', () => {
    const { pills, raw, group } = fakePills(['all', 'github', 'forgejo']);
    offerPills(pills, pools([fj, fj], [fj, fj]), actives('all'));
    expect(raw.map((p) => p.hidden)).toEqual([false, true, true]);
    expect(group.hidden).toBe(true);

    offerPills(pills, pools([gh, fj], [gh, fj]), actives('all'));
    expect(raw.map((p) => p.hidden)).toEqual([false, false, false]);
    expect(group.hidden).toBe(false);
  });

  test('hides Running CI when every item is running, keeps it when mixed', () => {
    const { pills, raw, group } = fakePills(['all', 'running']);
    offerPills(pills, pools([], [running, running]), actives('all'));
    expect(raw[1].hidden).toBe(true);
    expect(group.hidden).toBe(true);

    offerPills(pills, pools([], [running, gh]), actives('all'));
    expect(raw[1].hidden).toBe(false);
    expect(group.hidden).toBe(false);
  });

  test('keeps the active pill, and its group, even when it matches everything', () => {
    const { pills, raw, group } = fakePills(['all', 'running']);
    offerPills(pills, pools([], [running, running]), actives('running'));
    expect(raw[1].hidden).toBe(false);
    expect(group.hidden).toBe(false);
  });

  test('judges each group by its own pool', () => {
    const ci = fakePills(['all', 'running']);
    const forge = fakePills(['all', 'github', 'forgejo']);
    const all = [...ci.pills, ...forge.pills];
    // Forge pool is mixed, the CI pool is all running: only CI hides.
    offerPills(all, pools([gh, fj], [running, running]), actives('all'));
    expect(ci.group.hidden).toBe(true);
    expect(forge.group.hidden).toBe(false);
    // The CI pool offers a choice, the forge pool is one forge.
    offerPills(all, pools([fj, fj], [running, gh]), actives('all'));
    expect(ci.group.hidden).toBe(false);
    expect(forge.group.hidden).toBe(true);
  });

  test('never hides All on its own', () => {
    const { pills, raw } = fakePills(['all', 'running']);
    offerPills(pills, pools([], [gh, running]), actives('all'));
    expect(raw[0].hidden).toBe(false);
  });
});

// The issues page ignores the pull-request-only groups, so only the forge pick
// is in effect there (#3669, #3734).
describe('activePill and effectivePill', () => {
  const state = (
    shared: string,
    pr: Record<string, string>,
  ): SharedFilterState =>
    ({
      shared: { forge: shared },
      pr,
      issue: {},
      view: {},
    }) as SharedFilterState;

  test('each group reports its own pick, so a forge and a CI pick coexist', () => {
    const s = state('github', { ci: 'failing', review: 'ready' });
    expect(activePill(s, 'forge')).toBe('github');
    expect(activePill(s, 'ci')).toBe('failing');
    expect(activePill(s, 'merge')).toBe('all');
    expect(activePill(s, 'review')).toBe('ready');
  });

  test('a saved value the group does not offer reads as All', () => {
    expect(activePill(state('', { ci: 'bots', merge: 'failing' }), 'ci')).toBe(
      'all',
    );
    expect(activePill(state('', { merge: 'failing' }), 'merge')).toBe('all');
  });

  test('setPill changes one group and leaves the others', () => {
    const s = state('github', { ci: 'failing' });
    setPill(s, 'merge', 'conflicting');
    expect(s.shared.forge).toBe('github');
    expect(s.pr.ci).toBe('failing');
    expect(s.pr.merge).toBe('conflicting');
    setPill(s, 'ci', 'all');
    expect(s.pr.ci).toBe('');
    expect(s.pr.merge).toBe('conflicting');
    setPill(s, 'forge', 'forgejo');
    expect(s.shared.forge).toBe('forgejo');
  });

  test('setPill ignores a pill that is not in the group', () => {
    const s = state('', { ci: 'failing' });
    setPill(s, 'ci', 'conflicting');
    expect(s.pr.ci).toBe('');
  });

  test('on the issues page only the forge group is in effect', () => {
    const s = state('github', { ci: 'failing' });
    expect(effectivePill(s, 'forge', true)).toBe('github');
    expect(effectivePill(s, 'ci', true)).toBe('all');
    expect(effectivePill(s, 'ci', false)).toBe('failing');
  });

  test('the groups partition the quick filters', () => {
    const all = [
      ...PILL_GROUPS.ci,
      ...PILL_GROUPS.merge,
      ...PILL_GROUPS.review,
    ];
    expect([...all].sort()).toEqual([...QUICK_FILTERS].sort());
    expect(pillGroupOf('failing')).toBe('ci');
    expect(pillGroupOf('out-of-date')).toBe('merge');
    expect(pillGroupOf('ready')).toBe('review');
    expect(pillGroupOf('github')).toBe('forge');
  });

  test('the filters AND across groups', () => {
    const items = [
      choiceItem({ forge: 'github', ci: 'failure', failingCi: true }),
      choiceItem({ forge: 'forgejo', ci: 'failure', failingCi: true }),
      choiceItem({ forge: 'github', ci: 'success' }),
    ];
    const kept = items.filter((i) =>
      matchesFilters(i, true, { forge: 'github' }, { ci: 'failing' }),
    );
    expect(kept).toEqual([items[0]]);
    expect(
      failingFilters(items[1], true, { forge: 'github' }, { ci: 'failing' }),
    ).toEqual(['forge']);
    expect(failingFilters(items[2], true, {}, { ci: 'failing' })).toEqual([
      'ci',
    ]);
  });

  test('every group is named when its pick fails, and only then', () => {
    const item = choiceItem({ ci: 'success', mergeStatus: 'blocked' });
    expect(failingFilters(item, true, {}, { merge: 'conflicting' })).toEqual([
      'merge',
    ]);
    expect(
      failingFilters(item, true, {}, { review: 'review-requested' }),
    ).toEqual(['review']);
    expect(
      failingFilters(
        item,
        true,
        { forge: 'forgejo' },
        { ci: 'failing', merge: 'conflicting', review: 'review-requested' },
      ),
    ).toEqual(['forge', 'ci', 'merge', 'review']);
    expect(failingFilters(item, true, {}, { ci: 'passing' })).toEqual([]);
  });
});

// The Out of date pill lists the pull requests whose base branch moved on. It
// reads the same `behind` field as the row's badge, and an empty pull request
// is left out because the row draws no badge for one.
describe('the Out of date quick filter', () => {
  test('is a quick filter', () => {
    expect(QUICK_FILTERS).toContain('out-of-date');
  });

  test('matches a behind pull request that has something to merge', () => {
    expect(
      matchesQuickFilter(choiceItem({ behind: true }), 'out-of-date'),
    ).toBe(true);
    expect(
      matchesQuickFilter(
        choiceItem({ behind: true, draft: true }),
        'out-of-date',
      ),
    ).toBe(true);
  });

  test('leaves out one that is up to date, empty or not reported', () => {
    expect(
      matchesQuickFilter(choiceItem({ behind: false }), 'out-of-date'),
    ).toBe(false);
    expect(matchesQuickFilter(choiceItem(), 'out-of-date')).toBe(false);
    expect(
      matchesQuickFilter(
        choiceItem({ behind: true, empty: true }),
        'out-of-date',
      ),
    ).toBe(false);
  });
});

// The title box on the Issues, Pull requests and Bot PRs pages also takes a number. Pure, so it runs
// without a browser; the page wiring is in issues-number-filter.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/2155
describe('the title box and ticket numbers', () => {
  const issue = (number: number, title = 'Something') =>
    choiceItem({ number, title });
  const hits = (item: FilterableItem, term: string, isPR = false) =>
    matchesFilters(item, isPR, { title: term }, undefined);

  test('a number with or without # matches numbers that start with it', () => {
    for (const term of ['1884', '#1884', '18', '#18']) {
      expect(hits(issue(1884), term)).toBe(true);
    }
    expect(hits(issue(188), '1884')).toBe(false);
    expect(hits(issue(2188), '188')).toBe(false);
  });

  test('a # term matches the number, or a title that holds it as typed', () => {
    expect(hits(issue(7, 'Roadmap for 2024'), '#2024')).toBe(false);
    expect(hits(issue(2024), '#2024')).toBe(true);
    expect(hits(issue(7, 'Revert #1884'), '#1884')).toBe(true);
    expect(hits(issue(1884), ' #1884 ')).toBe(true);
  });

  test('a bare number still matches a title that holds it', () => {
    expect(hits(issue(7, 'Roadmap for 2024'), '2024')).toBe(true);
  });

  test('a text term matches the title as before', () => {
    expect(hits(issue(1, 'Dark mode'), 'dark')).toBe(true);
    expect(hits(issue(1, 'Dark mode'), 'light')).toBe(false);
  });

  test('a pull request matches numbers the way an issue does', () => {
    for (const term of ['1884', '#1884', '18', '#18']) {
      expect(hits(issue(1884), term, true)).toBe(true);
    }
    expect(hits(issue(188), '1884', true)).toBe(false);
    expect(hits(issue(2188), '188', true)).toBe(false);
    expect(hits(issue(7, 'Roadmap for 2024'), '#2024', true)).toBe(false);
    expect(hits(issue(1, 'Fix 1884'), '1884', true)).toBe(true);
    expect(hits(issue(1, 'Dark mode'), 'dark', true)).toBe(true);
  });
});

// The refs filter: pull requests that reference or close an issue, issues a
// pull request references or closes (a close is the strong form of a ref, #3655).
// The wiring is in refs-issues-filter.spec.ts.
describe('refsChoiceLabel', () => {
  test('words each choice as its button reads, per page', () => {
    expect(refsChoiceLabel(true, 'yes')).toBe('References an issue');
    expect(refsChoiceLabel(true, 'no')).toBe('References no issue');
    expect(refsChoiceLabel(false, 'yes')).toBe(
      'Has a referencing pull request',
    );
    expect(refsChoiceLabel(false, 'no')).toBe('No referencing pull request');
  });
});

describe('matchesRefs', () => {
  const link = { repo: 'a/b', number: 1 };
  const refs = choiceItem({ refsIssues: [link] });
  const none = choiceItem({});
  const empty = choiceItem({ refsIssues: [] });
  const referenced = choiceItem({ referencedByPullRequests: [link] });

  test('a pull request is matched on its refsIssues or its closesIssues', () => {
    expect(matchesRefs(refs, true, 'yes')).toBe(true);
    expect(matchesRefs(none, true, 'yes')).toBe(false);
    expect(matchesRefs(none, true, 'no')).toBe(true);
    expect(matchesRefs(empty, true, 'no')).toBe(true);
    expect(matchesRefs(refs, true, 'no')).toBe(false);
    const closer = choiceItem({ closesIssues: [link] });
    expect(matchesRefs(closer, true, 'yes')).toBe(true);
    expect(matchesRefs(closer, true, 'no')).toBe(false);
  });

  test('an issue is matched on its referencing or closing pull requests', () => {
    expect(matchesRefs(referenced, false, 'yes')).toBe(true);
    expect(matchesRefs(none, false, 'yes')).toBe(false);
    expect(matchesRefs(none, false, 'no')).toBe(true);
    const closed = choiceItem({ linkedPullRequests: [link] });
    expect(matchesRefs(closed, false, 'yes')).toBe(true);
    expect(matchesRefs(closed, false, 'no')).toBe(false);
  });

  test('no pick, or one it does not know, keeps everything', () => {
    expect(matchesRefs(none, true, undefined)).toBe(true);
    expect(matchesRefs(none, true, 'bogus')).toBe(true);
  });

  test('each page stores it under its own key', () => {
    expect(refsKey(true)).toBe('refs');
    expect(refsKey(false)).toBe('refBy');
  });

  test('failingFilters names the key; the old closing keys are not filters', () => {
    expect(failingFilters(none, true, {}, { refs: 'yes' })).toEqual(['refs']);
    expect(failingFilters(none, false, {}, { refBy: 'yes' })).toEqual([
      'refBy',
    ]);
    expect(failingFilters(refs, true, {}, { refs: 'yes' })).toEqual([]);
    expect(failingFilters(none, true, {}, { closes: 'yes' } as never)).toEqual(
      [],
    );
    expect(
      failingFilters(none, false, {}, { closedBy: 'yes' } as never),
    ).toEqual([]);
  });
});

// A segmented filter offers a choice only while something in the pool backs
// it (#3624), and the whole control only while there is a real choice: both
// choices backed, or a lone one that is the active pick (#3669). Any plus a
// lone choice filters nothing. The wiring is in refs-issues-filter.spec.ts,
// auto-merge-filter.spec.ts and segment-single-choice.spec.ts.
type FakeButton = { hidden: boolean };
function fakeSegment(attr: string, names: [string, string]) {
  const buttons: Record<string, FakeButton> = {
    [names[0]]: { hidden: false },
    [names[1]]: { hidden: false },
  };
  const group = {
    hidden: false,
    querySelector: (selector: string) => {
      const value = new RegExp(`\\[data-${attr}="(\\w+)"\\]`).exec(
        selector,
      )?.[1];
      return value ? (buttons[value] ?? null) : null;
    },
  };
  return { group: group as unknown as HTMLElement, buttons, state: group };
}

type Offer = (
  groups: HTMLElement[],
  pool: FilterableItem[],
  isPR: boolean,
  picked: string,
) => void;

const refsCases = [true, false].map((isPR) => ({
  name: `offerRefs, ${isPR ? 'pull requests' : 'issues'}`,
  attr: 'ref',
  names: ['yes', 'no'] as [string, string],
  isPR,
  offer: offerRefs as Offer,
  first: choiceItem(
    isPR
      ? { refsIssues: [{ repo: 'a/b', number: 1 }] }
      : { referencedByPullRequests: [{ repo: 'a/b', number: 1 }] },
  ),
  second: choiceItem({}),
}));
const autoMergeCase = {
  name: 'offerAutoMerge',
  attr: 'am',
  names: ['on', 'off'] as [string, string],
  isPR: true,
  offer: ((groups, pool, _isPR, picked) =>
    offerAutoMerge(groups, pool, picked)) as Offer,
  first: choiceItem({ autoMergeEnabled: true }),
  second: choiceItem({ autoMergeEnabled: false }),
};

describe.each([...refsCases, autoMergeCase])(
  '$name',
  ({ attr, names, isPR, offer, first, second }) => {
    const [a, b] = names;

    test('offers both choices and the segment when the pool has both kinds', () => {
      const { group, buttons, state } = fakeSegment(attr, names);
      offer([group], [first, second], isPR, '');
      expect(buttons[a].hidden).toBe(false);
      expect(buttons[b].hidden).toBe(false);
      expect(state.hidden).toBe(false);
    });

    test('hides the segment when only the first choice is backed and none is picked', () => {
      const { group, buttons, state } = fakeSegment(attr, names);
      offer([group], [first], isPR, '');
      expect(buttons[a].hidden).toBe(true);
      expect(buttons[b].hidden).toBe(true);
      expect(state.hidden).toBe(true);
    });

    test('hides the segment when only the second choice is backed and none is picked', () => {
      const { group, buttons, state } = fakeSegment(attr, names);
      offer([group], [second], isPR, '');
      expect(buttons[a].hidden).toBe(true);
      expect(buttons[b].hidden).toBe(true);
      expect(state.hidden).toBe(true);
    });

    test('hides the segment when there are no items', () => {
      const { group, buttons, state } = fakeSegment(attr, names);
      offer([group], [], isPR, '');
      expect(buttons[a].hidden).toBe(true);
      expect(buttons[b].hidden).toBe(true);
      expect(state.hidden).toBe(true);
    });

    test('keeps a lone backed choice and the segment when it is the pick', () => {
      const { group, buttons, state } = fakeSegment(attr, names);
      offer([group], [first], isPR, a);
      expect(buttons[a].hidden).toBe(false);
      expect(state.hidden).toBe(false);
    });

    test('keeps the picked choice when nothing backs it, and hides the one every item has', () => {
      const { group, buttons, state } = fakeSegment(attr, names);
      offer([group], [second], isPR, a);
      expect(buttons[a].hidden).toBe(false);
      expect(buttons[b].hidden).toBe(true);
      expect(state.hidden).toBe(false);
    });

    test('keeps a picked choice and its segment when the pool is empty', () => {
      const { group, buttons, state } = fakeSegment(attr, names);
      offer([group], [], isPR, a);
      expect(buttons[a].hidden).toBe(false);
      expect(buttons[b].hidden).toBe(true);
      expect(state.hidden).toBe(false);
    });
  },
);

// An item the forge does not report on is in neither On nor Off, so On still
// narrows a pool that holds one (#3669).
test('offerAutoMerge keeps On when an unreported item is in the pool', () => {
  const { group, buttons, state } = fakeSegment('am', ['on', 'off']);
  offerAutoMerge(
    [group],
    [choiceItem({ autoMergeEnabled: true }), choiceItem()],
    '',
  );
  expect(buttons.on.hidden).toBe(false);
  expect(buttons.off.hidden).toBe(true);
  expect(state.hidden).toBe(false);
});

// A saved author pick is lowercase, but the item's author keeps its capitals
// (#1620). The row must still match, and one by someone else must not.
describe('an author pick against a capitalised author', () => {
  test('matches the item whatever its case, and not another author', () => {
    const shared = { author: 'github:ryan' };
    expect(
      matchesFilters(choiceItem({ author: 'Ryan' }), false, shared, undefined),
    ).toBe(true);
    expect(
      matchesFilters(choiceItem({ author: 'sam' }), false, shared, undefined),
    ).toBe(false);
  });
});

describe('refsChoiceShort', () => {
  test('is short enough for Any and both choices to share a phone row', () => {
    expect(refsChoiceShort(false, 'yes')).toBe('Has PR');
    expect(refsChoiceShort(false, 'no')).toBe('No PR');
    expect(refsChoiceShort(true, 'yes')).toBe('Has issue');
    expect(refsChoiceShort(true, 'no')).toBe('No issue');
  });
});

// The Show drafts button is offered only when there is a draft to show (#3680):
// one on screen, or one the server left out and counted.
describe('offerDrafts', () => {
  const button = () => ({ hidden: false }) as unknown as HTMLElement;

  test('hides the button when no pull request is a draft and none are hidden', () => {
    const b = button();
    offerDrafts(b, [choiceItem(), choiceItem({ draft: false })], 0);
    expect(b.hidden).toBe(true);
  });

  test('shows it when the server left drafts out', () => {
    const b = button();
    offerDrafts(b, [choiceItem()], 2);
    expect(b.hidden).toBe(false);
  });

  test('shows it when a loaded pull request is a draft', () => {
    const b = button();
    offerDrafts(b, [choiceItem(), choiceItem({ draft: true })], 0);
    expect(b.hidden).toBe(false);
  });

  test('brings it back when a draft appears after it was hidden', () => {
    const b = button();
    offerDrafts(b, [], 0);
    expect(b.hidden).toBe(true);
    offerDrafts(b, [], 1);
    expect(b.hidden).toBe(false);
  });

  test('does nothing without a button', () => {
    expect(() => offerDrafts(null, [], 0)).not.toThrow();
  });
});

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
  ageChoices,
  ciBucket,
  type FilterableItem,
  matchesFilters,
  matchesQuickFilter,
  optionPool,
  QUICK_FILTERS,
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

    expect(repos(optionPool(items, false, { author: 'ryan' }, 'repo'))).toEqual(
      ['a/one'],
    );
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

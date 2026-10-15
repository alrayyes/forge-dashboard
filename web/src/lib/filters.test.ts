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
  ciChoices,
  type FilterableItem,
  matchesFilters,
  optionPool,
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

describe('ciChoices', () => {
  test('offers only the states items are in, in the select order', () => {
    expect(
      ciChoices([
        choiceItem({ ci: 'none' }),
        choiceItem({ ci: 'success' }),
      ]).map((c) => c.value),
    ).toEqual(['success', 'none']);
  });

  test('an item with no CI state adds nothing', () => {
    expect(ciChoices([choiceItem()])).toEqual([]);
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

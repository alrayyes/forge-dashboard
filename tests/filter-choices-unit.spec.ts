import { expect } from '@playwright/test';
import {
  ageChoices,
  ciChoices,
  type FilterableItem,
  matchesFilters,
} from '../web/src/lib/filters';
import { test } from './fixtures';

// Which fixed choices a set of items offers (#1427). Pure, so these run without
// a browser; the pages' wiring is in filter-choices-static.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/1427

const MINUTE = 60 * 1000;

function item(overrides: Partial<FilterableItem> = {}): FilterableItem {
  const now = new Date().toISOString();
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
  new Date(Date.now() - minutes * MINUTE).toISOString();
const offered = (items: FilterableItem[]) =>
  ageChoices(items, 'createdAt').map((c) => c.value);

test.describe('ageChoices', () => {
  test('a range is offered when an item is exactly its width old, and not one minute past it', () => {
    for (const [minutes, value] of [
      [60, '60'],
      [1440, '1440'],
      [10080, '10080'],
      [43200, '43200'],
    ] as const) {
      expect(offered([item({ createdAt: minutesOld(minutes) })])).toContain(
        value,
      );
      expect(
        offered([item({ createdAt: minutesOld(minutes + 1) })]),
      ).not.toContain(value);
    }
  });

  test('an offered range always matches something under the filter itself', () => {
    const items = [
      item({ createdAt: minutesOld(30) }),
      item({ createdAt: minutesOld(2000) }),
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
    expect(offered([item({ createdAt: minutesOld(60 * 24 * 90) })])).toEqual(
      [],
    );
  });

  test('an invalid date is never counted in a range', () => {
    expect(offered([item({ createdAt: 'not a date' })])).toEqual([]);
  });
});

test.describe('ciChoices', () => {
  test('offers only the states items are in, in the select order', () => {
    expect(
      ciChoices([item({ ci: 'none' }), item({ ci: 'success' })]).map(
        (c) => c.value,
      ),
    ).toEqual(['success', 'none']);
  });

  test('an item with no CI state adds nothing', () => {
    expect(ciChoices([item()])).toEqual([]);
  });
});

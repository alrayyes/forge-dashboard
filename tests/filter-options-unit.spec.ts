import { expect } from '@playwright/test';
import { type FilterableItem, optionPool } from '../web/src/lib/filters';
import { test } from './fixtures';

// Which items a filter's own choices come from (#1427). Pure, so these run
// without a browser; the pages' wiring is in filter-options.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/1427

function item(overrides: Partial<FilterableItem> = {}): FilterableItem {
  const now = new Date().toISOString();
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

test.describe('optionPool', () => {
  test('keeps what the other filters let through and drops the rest', () => {
    const items = [
      item({ repo: 'a/one', author: 'ryan' }),
      item({ repo: 'a/two', author: 'claude' }),
    ];

    expect(repos(optionPool(items, false, { author: 'ryan' }, 'repo'))).toEqual(
      ['a/one'],
    );
  });

  test('leaves the filter being populated out, so a picked value keeps its siblings', () => {
    const items = [item({ repo: 'a/one' }), item({ repo: 'a/two' })];

    expect(
      repos(optionPool(items, false, { repo: 'github:a/one' }, 'repo')),
    ).toEqual(['a/one', 'a/two']);
    expect(
      repos(optionPool(items, false, { repo: 'github:a/one' }, 'author')),
    ).toEqual(['a/one']);
  });

  test('drops a housekeeping issue while the page hides it, and keeps it once it does not', () => {
    const items = [
      item({ repo: 'a/real' }),
      item({ repo: 'a/dash', housekeeping: true }),
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
      item({ title: 'Fix a bug' }),
      item({ title: 'Add a feature' }),
    ];

    expect(optionPool(items, false, { title: 'bug' }, '')).toHaveLength(1);
  });
});

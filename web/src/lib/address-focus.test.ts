/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { addressFocusFallback } from './address-focus';

// The fallback for a pull request opened from its address: where focus goes
// on close when its row is filtered out. The title box hides over one row
// (#3823), so the fallback has to name a control that is drawn (#3844).
const drawnIds = (...ids: string[]) => {
  const set = new Set(ids);
  return (id: string) => set.has(id);
};

describe('addressFocusFallback', () => {
  test('names the title box while it is drawn', () => {
    expect(
      addressFocusFallback(
        drawnIds('title-filter', 'filters-button', 'pr-sort-select'),
      ),
    ).toBe('title-filter');
  });

  test('names the Filters button when the title box is hidden on a phone', () => {
    expect(
      addressFocusFallback(drawnIds('filters-button', 'pr-sort-select')),
    ).toBe('filters-button');
  });

  test('names the sort box when the title box is hidden and there is no Filters button', () => {
    expect(addressFocusFallback(drawnIds('pr-sort-select'))).toBe(
      'pr-sort-select',
    );
  });

  test('prefers the title box, then the Filters button, then the sort box', () => {
    expect(
      addressFocusFallback(drawnIds('title-filter', 'pr-sort-select')),
    ).toBe('title-filter');
    expect(
      addressFocusFallback(drawnIds('title-filter', 'filters-button')),
    ).toBe('title-filter');
    expect(
      addressFocusFallback(drawnIds('filters-button', 'pr-sort-select')),
    ).toBe('filters-button');
    expect(addressFocusFallback(drawnIds('pr-sort-select'))).toBe(
      'pr-sort-select',
    );
  });
});

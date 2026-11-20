/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  ADDRESS_CANDIDATES,
  chainedReturn,
  focusFallback,
  POPUP_CANDIDATES,
} from './address-focus';

// The fallback for a pull request opened from its address: where focus goes
// on close when its row is filtered out. The title box hides over one row
// (#3823), so the fallback has to name a control that is drawn (#3844).
const addressFallback = (isDrawn: (id: string) => boolean) =>
  focusFallback(ADDRESS_CANDIDATES, isDrawn);

const drawnIds = (...ids: string[]) => {
  const set = new Set(ids);
  return (id: string) => set.has(id);
};

describe('focusFallback over the address candidates', () => {
  test('names the title box while it is drawn and no Filters button is', () => {
    expect(addressFallback(drawnIds('title-filter', 'pr-sort-select'))).toBe(
      'title-filter',
    );
  });

  test('names the Filters button on a phone, where the title box is also drawn', () => {
    expect(
      addressFallback(
        drawnIds('title-filter', 'filters-button', 'pr-sort-select'),
      ),
    ).toBe('filters-button');
  });

  test('names the Filters button when the title box is hidden', () => {
    expect(addressFallback(drawnIds('filters-button', 'pr-sort-select'))).toBe(
      'filters-button',
    );
  });

  test('names the sort box when the title box is hidden and there is no Filters button', () => {
    expect(addressFallback(drawnIds('pr-sort-select'))).toBe('pr-sort-select');
  });

  test('prefers the Filters button, then the title box, then the sort box', () => {
    expect(addressFallback(drawnIds('title-filter', 'filters-button'))).toBe(
      'filters-button',
    );
    expect(addressFallback(drawnIds('title-filter', 'pr-sort-select'))).toBe(
      'title-filter',
    );
    expect(addressFallback(drawnIds('pr-sort-select'))).toBe('pr-sort-select');
  });

  test('moves past a sort box that is not offered, to the next control', () => {
    expect(addressFallback(drawnIds('created-filter'))).toBe('created-filter');
    expect(
      addressFallback(drawnIds('updated-filter', 'clear-filters-button')),
    ).toBe('updated-filter');
    expect(addressFallback(drawnIds('clear-filters-button'))).toBe(
      'clear-filters-button',
    );
  });
});

// Dialogs swapped one for another return focus to where the first swap sent
// it, not to a pill inside a dialog that is gone (#4351).
describe('chainedReturn', () => {
  test('keeps what the first swap sent focus to', () => {
    expect(chainedReturn('details-trigger-1', 'pill-in-gone-dialog')).toBe(
      'details-trigger-1',
    );
  });

  test('uses the pill own id when no swap came before', () => {
    expect(chainedReturn(null, 'pill-in-gone-dialog')).toBe(
      'pill-in-gone-dialog',
    );
  });

  test('uses the pill own id when the earlier swap named none', () => {
    expect(chainedReturn('', 'pill-in-gone-dialog')).toBe(
      'pill-in-gone-dialog',
    );
  });
});

describe('focusFallback over the pop-up candidates', () => {
  test('names the Filters button where one is drawn', () => {
    expect(
      focusFallback(
        POPUP_CANDIDATES,
        drawnIds('title-filter', 'filters-button'),
      ),
    ).toBe('filters-button');
  });

  test('names the title box otherwise', () => {
    expect(focusFallback(POPUP_CANDIDATES, drawnIds('title-filter'))).toBe(
      'title-filter',
    );
  });

  test('never reaches past the Filters button and the title box', () => {
    expect(focusFallback(POPUP_CANDIDATES, drawnIds('pr-sort-select'))).toBe(
      'title-filter',
    );
  });

  test('takes any list it is given', () => {
    expect(focusFallback(['a', 'b', 'c'], drawnIds('b', 'c'))).toBe('b');
    expect(focusFallback(['a', 'b', 'c'], drawnIds())).toBe('c');
  });
});

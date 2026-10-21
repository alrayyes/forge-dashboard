/// <reference types="bun" />
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  filtersAreDefault,
  releaseAllHeld,
  type SharedFilterState,
} from './filters';

// Clear filters is disabled only when nothing on this page is picked. The
// closing-link pick is per page, so the other page's pick must not count.
// https://github.com/alrayyes/forge-dashboard/issues/2322

beforeEach(() => releaseAllHeld());

function state(over: Partial<SharedFilterState> = {}): SharedFilterState {
  return {
    shared: {},
    pr: {},
    issue: { hideDependencyDashboard: '1' },
    view: {},
    ...over,
  };
}

const page = (pullsView: boolean) => ({
  pullsView,
  settingsHideDependencyDashboard: false,
  settingsIgnoreTitles: false,
});

describe('filtersAreDefault', () => {
  test('a fresh state is default on both pages', () => {
    expect(filtersAreDefault(state(), page(true))).toBe(true);
    expect(filtersAreDefault(state(), page(false))).toBe(true);
  });

  test('a closing pick on Pull requests does not enable Clear on Issues', () => {
    const s = state({ pr: { closes: 'yes' } });
    expect(filtersAreDefault(s, page(false))).toBe(true);
    expect(filtersAreDefault(s, page(true))).toBe(false);
  });

  test('a closing pick on Issues does not enable Clear on Pull requests', () => {
    const s = state({
      issue: { hideDependencyDashboard: '1', closedBy: 'no' },
    });
    expect(filtersAreDefault(s, page(true))).toBe(true);
    expect(filtersAreDefault(s, page(false))).toBe(false);
  });
});

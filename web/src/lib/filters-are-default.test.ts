/// <reference types="bun" />
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  filtersAreDefault,
  releaseAllHeld,
  type SharedFilterState,
} from './filters';

// Clear filters is disabled only when nothing on this page is picked. The
// refs pick is per page, so the other page's pick must not count.
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

  test('a refs pick counts only on its own page', () => {
    const pr = state({ pr: { refs: 'yes' } });
    expect(filtersAreDefault(pr, page(false))).toBe(true);
    expect(filtersAreDefault(pr, page(true))).toBe(false);
    const issue = state({
      issue: { hideDependencyDashboard: '1', refBy: 'no' },
    });
    expect(filtersAreDefault(issue, page(true))).toBe(true);
    expect(filtersAreDefault(issue, page(false))).toBe(false);
  });
});

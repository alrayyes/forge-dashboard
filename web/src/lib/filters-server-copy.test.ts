/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { applyServerState, type SharedFilterState } from './filters';

// The server copy of "Hide Dependency Dashboard" is '' when the box is off.
// That has to replace the page's default of '1', or a second browser would
// show the box ticked.
describe('applyServerState with the hide Dependency Dashboard choice', () => {
  const fresh = (): SharedFilterState => ({
    shared: {},
    pr: {},
    issue: { hideDependencyDashboard: '1' },
    view: {},
  });

  test('an off value from the server replaces the default', () => {
    const state = fresh();
    applyServerState(state, { issue: { hideDependencyDashboard: '' } });
    expect(state.issue.hideDependencyDashboard).toBe('');
  });

  test('a server copy without the key leaves the default on', () => {
    const state = fresh();
    applyServerState(state, { shared: { repo: 'github:acme/app' } });
    expect(state.issue.hideDependencyDashboard).toBe('1');
  });
});

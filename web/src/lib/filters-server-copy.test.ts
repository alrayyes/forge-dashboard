/// <reference types="bun" />
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  applyServerState,
  currentPage,
  hasTouched,
  heldPicks,
  holdStale,
  leavePage,
  loadState,
  releaseAllHeld,
  type SharedFilterState,
  touchAll,
  touchKey,
} from './filters';

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

// A filter changed while the saved copy loads is newer than the copy, so the
// late copy must not overwrite it (#1713).
describe('applyServerState with keys the user touched', () => {
  const fresh = (): SharedFilterState => ({
    shared: {},
    pr: {},
    issue: { hideDependencyDashboard: '1' },
    view: {},
  });

  beforeEach(() => {
    Object.assign(globalThis, { document: { cookie: '' } });
    loadState();
    releaseAllHeld();
  });

  test('a touched key keeps the user value, an untouched one takes the copy', () => {
    const state = fresh();
    state.issue.hideDependencyDashboard = '';
    touchKey('issue', 'hideDependencyDashboard');
    applyServerState(state, {
      issue: { hideDependencyDashboard: '1' },
      shared: { repo: 'github:acme/app' },
      pr: { status: 'failing' },
    });
    expect(state.issue.hideDependencyDashboard).toBe('');
    expect(state.shared.repo).toBe('github:acme/app');
    expect(state.pr.status).toBe('failing');
    expect(hasTouched()).toBe(true);
  });

  test('a key touched in one group does not protect the same key in another', () => {
    const state = fresh();
    state.shared.title = 'mine';
    touchKey('shared', 'title');
    applyServerState(state, {
      shared: { title: 'theirs' },
      issue: { title: 'theirs' },
    });
    expect(state.shared.title).toBe('mine');
    expect(state.issue.title).toBe('theirs');
  });

  test('nothing touched applies the whole copy as before', () => {
    const state = fresh();
    expect(hasTouched()).toBe(false);
    applyServerState(state, {
      shared: { repo: 'github:acme/app' },
      issue: { hideDependencyDashboard: '' },
      view: { sort: 'repo' },
    });
    expect(state.shared.repo).toBe('github:acme/app');
    expect(state.issue.hideDependencyDashboard).toBe('');
    expect(state.view.sort).toBe('repo');
  });

  test('Clear filters touches every filter key, including ones it left empty', () => {
    const state = fresh();
    touchAll();
    applyServerState(state, {
      shared: { repo: 'github:acme/app' },
      pr: { quick: 'ready' },
      issue: { hideDependencyDashboard: '', hideTitleRegex: 'x' },
      view: { sort: 'repo' },
    });
    expect(state.shared.repo).toBeUndefined();
    expect(state.pr.quick).toBeUndefined();
    expect(state.issue.hideDependencyDashboard).toBe('1');
    expect(state.issue.hideTitleRegex).toBeUndefined();
    // How the list is shown is not a filter, Clear filters leaves it alone.
    expect(state.view.sort).toBe('repo');
  });

  test('loading the state again starts a page with nothing touched', () => {
    touchKey('shared', 'repo');
    touchAll();
    loadState();
    expect(hasTouched()).toBe(false);
    const state = fresh();
    applyServerState(state, { shared: { repo: 'github:acme/app' } });
    expect(state.shared.repo).toBe('github:acme/app');
  });

  test('a held pick the copy agrees with stays held, touched or not', () => {
    const state = fresh();
    state.shared.author = 'bob';
    holdStale(state, 'shared', 'author');
    touchKey('shared', 'repo');
    applyServerState(state, { shared: { author: 'bob', repo: 'x' } });
    expect(state.shared.author).toBe('');
    expect(heldPicks().length).toBe(1);
  });

  test('a saved-copy callback can tell its page is no longer the current one', () => {
    const page = currentPage();
    loadState();
    expect(currentPage()).not.toBe(page);
  });

  test('leaving a page ends it and its touched keys', () => {
    const page = currentPage();
    touchKey('shared', 'repo');
    leavePage(page);
    expect(currentPage()).not.toBe(page);
    expect(hasTouched()).toBe(false);
  });

  test('a page leaving after the next one loaded leaves the next one alone', () => {
    const old = currentPage();
    loadState();
    const next = currentPage();
    touchKey('shared', 'repo');
    leavePage(old);
    expect(currentPage()).toBe(next);
    expect(hasTouched()).toBe(true);
  });
});

/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
  takeMigratedStatus,
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
      pr: { autoMerge: 'on' },
    });
    expect(state.issue.hideDependencyDashboard).toBe('');
    expect(state.shared.repo).toBe('github:acme/app');
    expect(state.pr.autoMerge).toBe('on');
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
    expect(state.pr.review).toBeUndefined();
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

// The CI status pulldown is gone (2084): a status saved from before becomes the
// pill it matches, so it neither disappears nor filters out of sight. A pill or
// a forge already picked wins, and the old key never stays in the state.
describe('a saved CI status after the pulldown went', () => {
  // Keys touched by an earlier test would keep the user's value.
  beforeEach(() => {
    loadState();
  });

  const fresh = (): SharedFilterState => ({
    shared: {},
    pr: {},
    issue: {},
    view: {},
  });

  test.each([
    ['success', 'passing'],
    ['failure', 'failing'],
    ['pending', 'running'],
    ['none', 'no-checks'],
  ])('%s from the server copy becomes the %s pill', (status, pill) => {
    const state = fresh();
    applyServerState(state, { pr: { status } });
    expect(state.pr.ci).toBe(pill);
    expect(state.pr.status).toBeUndefined();
  });

  test('a CI pill already picked stays and the status is dropped', () => {
    const state = fresh();
    state.pr.ci = 'running';
    applyServerState(state, { pr: { status: 'failure' } });
    expect(state.pr.ci).toBe('running');
    expect(state.pr.status).toBeUndefined();
  });

  test('a forge already picked no longer blocks it, the groups combine', () => {
    const state = fresh();
    state.shared.forge = 'github';
    applyServerState(state, { pr: { status: 'failure' } });
    expect(state.pr.ci).toBe('failing');
    expect(state.shared.forge).toBe('github');
  });

  test('a status that is not a known one is dropped', () => {
    const state = fresh();
    applyServerState(state, { pr: { status: 'bogus' } });
    expect(state.pr.ci ?? '').toBe('');
    expect(state.pr.status).toBeUndefined();
  });

  test('a pill the user picked meanwhile wins over the copy', () => {
    const state = fresh();
    state.pr.ci = '';
    touchKey('pr', 'ci');
    applyServerState(state, { pr: { status: 'failure' } });
    expect(state.pr.ci).toBe('');
    expect(state.pr.status).toBeUndefined();
  });

  test('says a saved status was read, once', () => {
    takeMigratedStatus();
    applyServerState(fresh(), { pr: { status: 'success' } });
    expect(takeMigratedStatus()).toBe(true);
    expect(takeMigratedStatus()).toBe(false);
    applyServerState(fresh(), { pr: { autoMerge: 'on' } });
    expect(takeMigratedStatus()).toBe(false);
  });
});

// The single quick pill became four groups (#3734). A saved pr.quick moves to
// the key of the group its value belongs to, once.
describe('the saved quick pill becomes a per-group pick', () => {
  const fresh = (): SharedFilterState => ({
    shared: {},
    pr: {},
    issue: {},
    view: {},
  });

  test.each([
    ['failing', 'ci'],
    ['no-checks', 'ci'],
    ['conflicting', 'merge'],
    ['out-of-date', 'merge'],
    ['ready', 'review'],
    ['needs-review', 'review'],
    ['review-requested', 'review'],
  ])('a saved %s lands in pr.%s', (pill, key) => {
    const state = fresh();
    applyServerState(state, { pr: { quick: pill } });
    expect(state.pr[key]).toBe(pill);
    expect('quick' in state.pr).toBe(false);
  });

  test('a saved failing lands as pr.ci failing and the old key is gone', () => {
    const state = fresh();
    applyServerState(state, { pr: { quick: 'failing' } });
    expect(state.pr.ci).toBe('failing');
    expect('quick' in state.pr).toBe(false);
  });

  describe('from the cookie alone', () => {
    const realDocument = globalThis.document;
    afterEach(() => {
      Object.assign(globalThis, { document: realDocument });
    });

    test('loadState moves a saved pr.quick to its group', () => {
      const saved = {
        shared: {},
        pr: { quick: 'failing' },
        issue: {},
        view: {},
      };
      Object.assign(globalThis, {
        document: {
          cookie: `forge-board-filters=${encodeURIComponent(JSON.stringify(saved))}`,
        },
      });
      const state = loadState();
      expect(state.pr.ci).toBe('failing');
      expect('quick' in state.pr).toBe(false);
    });
  });

  test('a pill that no longer exists is dropped', () => {
    const state = fresh();
    applyServerState(state, { pr: { quick: 'bots' } });
    expect(state.pr.quick).toBeUndefined();
    expect(state.pr.ci ?? '').toBe('');
  });

  test('a group already picked keeps its value', () => {
    const state = fresh();
    state.pr.ci = 'running';
    applyServerState(state, { pr: { quick: 'failing' } });
    expect(state.pr.ci).toBe('running');
  });

  test('a group the user touched meanwhile wins over the copy', () => {
    const state = fresh();
    state.pr.ci = '';
    touchKey('pr', 'ci');
    applyServerState(state, { pr: { quick: 'failing' } });
    expect(state.pr.ci).toBe('');
  });

  test('says a saved quick pill was read, once, so the page saves the new shape', () => {
    takeMigratedStatus();
    applyServerState(fresh(), { pr: { quick: 'ready' } });
    expect(takeMigratedStatus()).toBe(true);
    expect(takeMigratedStatus()).toBe(false);
  });
});

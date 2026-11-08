/// <reference types="bun" />
import { beforeEach, describe, expect, test } from 'bun:test';

// The store is a .svelte.ts module, which needs the Svelte compiler for its
// $state rune. A plain object has the same reads and writes for these checks.
(globalThis as Record<string, unknown>).$state = <T>(value: T) => value;
const {
  dashboardRead,
  resetDashboardRead,
  retryDashboardRead,
  setDashboardRereader,
  settleDashboardRead,
} = await import('./dashboard-read.svelte');

// Insights and Webhooks need to tell a read that failed from one that has not
// answered yet, without changing what latches (#1801).
// https://github.com/alrayyes/forge-dashboard/issues/3212

const done = { firstRefreshDone: true, repos: [] };

describe('dashboardRead.lastError', () => {
  beforeEach(() => resetDashboardRead());

  test('starts empty', () => {
    expect(dashboardRead.lastError).toBeNull();
  });

  test('a 5xx records the error and settles nothing', () => {
    settleDashboardRead(null, 500, 'The backend answered with an error (500).');
    expect(dashboardRead.lastError).toBe(
      'The backend answered with an error (500).',
    );
    expect(dashboardRead.state).toBe('pending');
    expect(dashboardRead.latched).toBe(false);
  });

  test('a network error records the error and settles nothing', () => {
    settleDashboardRead(null, 0, 'Could not reach the backend: offline');
    expect(dashboardRead.lastError).toBe(
      'Could not reach the backend: offline',
    );
    expect(dashboardRead.state).toBe('pending');
  });

  test('the next answer clears it', () => {
    settleDashboardRead(null, 502, 'The backend answered with an error (502).');
    settleDashboardRead(done);
    expect(dashboardRead.lastError).toBeNull();
    expect(dashboardRead.state).toBe('answered');
  });

  test('a first-refresh answer that is not done clears it too', () => {
    settleDashboardRead(null, 500, 'The backend answered with an error (500).');
    settleDashboardRead({ firstRefreshDone: false });
    expect(dashboardRead.lastError).toBeNull();
    expect(dashboardRead.latched).toBe(false);
  });

  test('a later failure after an answer is recorded while the data stays', () => {
    settleDashboardRead({ firstRefreshDone: false, repos: [] });
    settleDashboardRead(null, 503, 'The backend answered with an error (503).');
    expect(dashboardRead.lastError).toBe(
      'The backend answered with an error (503).',
    );
    expect(dashboardRead.data).not.toBeNull();
  });

  test('a 404 latches as a failure and is recorded', () => {
    settleDashboardRead(null, 404, 'The backend answered with an error (404).');
    expect(dashboardRead.state).toBe('failed');
    expect(dashboardRead.latched).toBe(true);
    expect(dashboardRead.lastError).toBe(
      'The backend answered with an error (404).',
    );
  });

  test('a 401 latches but records no error, since the page leaves', () => {
    settleDashboardRead(null, 401, 'The backend answered with an error (401).');
    expect(dashboardRead.state).toBe('failed');
    expect(dashboardRead.status).toBe(401);
    expect(dashboardRead.lastError).toBeNull();
  });

  test('once latched, a later failure is ignored', () => {
    settleDashboardRead(done);
    settleDashboardRead(null, 500, 'The backend answered with an error (500).');
    expect(dashboardRead.lastError).toBeNull();
    expect(dashboardRead.state).toBe('answered');
  });

  test('reset clears it', () => {
    settleDashboardRead(null, 500, 'The backend answered with an error (500).');
    resetDashboardRead();
    expect(dashboardRead.lastError).toBeNull();
  });
});

describe('retryDashboardRead', () => {
  beforeEach(() => {
    resetDashboardRead();
    setDashboardRereader(null);
  });

  test('runs the layout read', () => {
    let reads = 0;
    setDashboardRereader(() => reads++);
    retryDashboardRead();
    expect(reads).toBe(1);
  });

  test('lifts a latched 4xx so the next answer decides', () => {
    settleDashboardRead(null, 403, 'The backend answered with an error (403).');
    expect(dashboardRead.latched).toBe(true);
    setDashboardRereader(() => settleDashboardRead(done));
    retryDashboardRead();
    expect(dashboardRead.state).toBe('answered');
    expect(dashboardRead.lastError).toBeNull();
    expect(dashboardRead.data).toEqual(done);
  });

  test('keeps the error until the read answers', () => {
    settleDashboardRead(null, 403, 'The backend answered with an error (403).');
    setDashboardRereader(() => {});
    retryDashboardRead();
    expect(dashboardRead.state).toBe('pending');
    expect(dashboardRead.lastError).toBe(
      'The backend answered with an error (403).',
    );
  });
});

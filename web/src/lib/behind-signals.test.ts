/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { showsBehindPill, showsBehindStatus } from './behind-signals';

const behindRow = {
  behind: true,
  empty: false,
  onRow: true,
  conflictShown: false,
  liveUpdateBranch: false,
  rebaseRequested: false,
};

describe('showsBehindPill', () => {
  test('a behind row with nothing else saying it draws the pill', () => {
    expect(showsBehindPill(behindRow)).toBe(true);
  });

  test('a requested rebase on the row drops the pill', () => {
    expect(showsBehindPill({ ...behindRow, rebaseRequested: true })).toBe(
      false,
    );
  });

  test('the pop-up keeps the pill while a rebase is requested', () => {
    expect(
      showsBehindPill({ ...behindRow, onRow: false, rebaseRequested: true }),
    ).toBe(true);
  });

  test('the pop-up drops the pill beside a confirmed conflict (#4531)', () => {
    expect(
      showsBehindPill({ ...behindRow, onRow: false, conflictShown: true }),
    ).toBe(false);
  });

  test('a rebase that timed out brings the pill back', () => {
    expect(showsBehindPill({ ...behindRow, rebaseRequested: false })).toBe(
      true,
    );
  });

  test('a row that is not behind, or is empty, never draws it', () => {
    expect(showsBehindPill({ ...behindRow, behind: false })).toBe(false);
    expect(showsBehindPill({ ...behindRow, empty: true })).toBe(false);
  });

  test('a confirmed conflict or a live Update branch still drops it', () => {
    expect(showsBehindPill({ ...behindRow, conflictShown: true })).toBe(false);
    expect(showsBehindPill({ ...behindRow, liveUpdateBranch: true })).toBe(
      false,
    );
  });
});

describe('showsBehindStatus', () => {
  test('a requested rebase on the row drops the behind message', () => {
    expect(showsBehindStatus('behind', true, true)).toBe(false);
  });

  test('without a request the message stays', () => {
    expect(showsBehindStatus('behind', false, true)).toBe(true);
  });

  test('the pop-up keeps the message', () => {
    expect(showsBehindStatus('behind', true, false)).toBe(true);
  });

  test('other statuses are never hidden by a request', () => {
    expect(showsBehindStatus('ci_pending', true, true)).toBe(true);
    expect(showsBehindStatus(undefined, true, true)).toBe(true);
  });
});

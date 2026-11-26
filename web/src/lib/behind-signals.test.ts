/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  dropsBehindMerge,
  fixRequested,
  showsBehindPill,
  showsBehindStatus,
} from './behind-signals';

const behindRow = {
  outOfDate: true,
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

  test('a row the server does not call out of date never draws it', () => {
    expect(showsBehindPill({ ...behindRow, outOfDate: false })).toBe(false);
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

describe('fixRequested', () => {
  test('a bot rebase or an Update branch request counts', () => {
    expect(fixRequested(true, false)).toBe(true);
    expect(fixRequested(false, true)).toBe(true);
  });

  test('neither request is no request', () => {
    expect(fixRequested(false, false)).toBe(false);
  });
});

describe('dropsBehindMerge (#4532)', () => {
  test('a row waiting on its own update request drops the locked Merge', () => {
    expect(dropsBehindMerge('behind', true, true)).toBe(true);
  });

  test('the pop-up keeps the locked Merge', () => {
    expect(dropsBehindMerge('behind', true, false)).toBe(false);
  });

  test('a behind row with no request keeps it', () => {
    expect(dropsBehindMerge('behind', false, true)).toBe(false);
  });

  test('a conflict or draft keeps its locked Merge whatever was asked', () => {
    expect(dropsBehindMerge('conflict', true, true)).toBe(false);
    expect(dropsBehindMerge('draft', true, true)).toBe(false);
  });
});

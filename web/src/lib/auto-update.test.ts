/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  type AutoUpdate,
  autoUpdateBadge,
  autoUpdateControl,
} from './auto-update';

// What the dialog's checkbox says about a pull request's automatic branch
// update. The server decides the state; this only words it.

const state = (over: Partial<AutoUpdate> = {}): AutoUpdate => ({
  enabled: true,
  source: 'repo',
  unavailable: null,
  ...over,
});

describe('autoUpdateControl', () => {
  test('a pull request that follows the repo is checked as the repo is, and says so', () => {
    expect(autoUpdateControl(state({ enabled: true }))).toEqual({
      checked: true,
      disabled: false,
      note: "From the repo's setting.",
      canReset: false,
    });
    expect(autoUpdateControl(state({ enabled: false }))?.checked).toBe(false);
  });

  test('a choice made for this pull request says so and offers the way back', () => {
    const control = autoUpdateControl(
      state({ enabled: false, source: 'pullRequest' }),
    );

    expect(control?.note).toBe('Set for this pull request.');
    expect(control?.canReset).toBe(true);
  });

  test('an unavailable pull request is unchecked, disabled, and gives the server’s reason', () => {
    const control = autoUpdateControl(
      state({
        enabled: false,
        source: 'pullRequest',
        unavailable: { code: 'draft', reason: 'A draft is never updated.' },
      }),
    );

    expect(control).toEqual({
      checked: false,
      disabled: true,
      note: 'A draft is never updated.',
      canReset: false,
    });
  });

  test('a server that sends nothing draws no control', () => {
    expect(autoUpdateControl(undefined)).toBeNull();
  });
});

describe('autoUpdateBadge', () => {
  test('only a choice that differs from the repo gets a marker, in words', () => {
    expect(
      autoUpdateBadge(state({ enabled: false, source: 'pullRequest' })),
    ).toBe('Auto-update off');
    expect(
      autoUpdateBadge(state({ enabled: true, source: 'pullRequest' })),
    ).toBe('Auto-update on');
  });

  test('following the repo, or unavailable, draws no marker', () => {
    expect(autoUpdateBadge(state())).toBeNull();
    expect(
      autoUpdateBadge(
        state({
          source: 'pullRequest',
          unavailable: { code: 'draft', reason: 'x' },
        }),
      ),
    ).toBeNull();
    expect(autoUpdateBadge(undefined)).toBeNull();
  });
});

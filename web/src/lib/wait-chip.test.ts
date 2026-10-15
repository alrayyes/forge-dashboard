/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  type AutoMergeInput,
  autoMergeChip,
  queuedChip,
  SETTLED_MS,
  STILL_WAITING_MS,
  settledChip,
  type WaitInput,
  type WaitKind,
  waitChip,
} from './wait-chip';

// The chip's wording lives in one module, so the wording is checked here
// without a browser. The page wiring is wait-chip.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/1229

const kinds: WaitKind[] = [
  'bot-rebase',
  'bot-recreate',
  'update-branch',
  'merge',
  'close',
  'enable-auto-merge',
  'cancel-auto-merge',
];

function input(overrides: Partial<WaitInput> = {}): WaitInput {
  return {
    kind: 'bot-rebase',
    phase: 'queued',
    bot: 'Dependabot',
    sinceChangeMs: 0,
    ...overrides,
  };
}

const words = (text: string) => text.trim().split(/\s+/).length;

const OLD_TEXT =
  /Awaiting the next refresh|Waiting for Dependabot|Waiting for Renovate|will pick this up shortly|Waiting for CI to restart/;

describe('waitChip wording', () => {
  test('a queued bot rebase names the bot and counts its age', () => {
    const chip = waitChip(input());
    expect(chip.state).toBe('waiting');
    expect(chip.icon).toBe('spinner');
    expect(chip.label).toBe('Rebase requested');
    expect(chip.detail).toBe('Dependabot');
    expect(chip.showAgo).toBe(true);
    expect(chip.action).toBeUndefined();
  });

  test('an acknowledged Dependabot rebase says it got the command', () => {
    const chip = waitChip(input({ acknowledged: true }));
    expect(chip.label).toBe('Rebase requested');
    expect(chip.detail).toBe('Dependabot got it');
  });

  test('a picked-up rebase reads Rebasing', () => {
    const chip = waitChip(input({ phase: 'rebasing', bot: 'Renovate' }));
    expect(chip.label).toBe('Rebasing');
    expect(chip.detail).toBe('Renovate');
    expect(chip.tooltip).toContain('Renovate picked this up');
  });

  test('Update branch reads Updating branch and counts down to the refresh', () => {
    const chip = waitChip(input({ kind: 'update-branch', bot: undefined }));
    expect(chip.label).toBe('Updating branch');
    expect(chip.countdown).toBe(true);
    expect(chip.showAgo).toBe(false);
  });

  test('a merge and a close in progress each read as one word', () => {
    expect(
      waitChip(input({ kind: 'merge', phase: 'working', bot: undefined }))
        .label,
    ).toBe('Merging');
    expect(
      waitChip(input({ kind: 'close', phase: 'working', bot: undefined }))
        .label,
    ).toBe('Closing');
  });

  test('every label is at most three words, and none is an old line', () => {
    for (const kind of kinds) {
      for (const phase of ['working', 'queued', 'rebasing'] as const) {
        for (const sinceChangeMs of [0, STILL_WAITING_MS]) {
          const chip = waitChip(input({ kind, phase, sinceChangeMs }));
          expect(words(chip.label)).toBeLessThanOrEqual(3);
          for (const text of [chip.label, chip.detail, chip.tooltip])
            expect(text).not.toMatch(OLD_TEXT);
        }
      }
    }
  });

  test('two minutes with no change turns any wait into Still waiting with Check again', () => {
    for (const kind of kinds) {
      const early = waitChip(
        input({ kind, sinceChangeMs: STILL_WAITING_MS - 1 }),
      );
      expect(early.state).toBe('waiting');
      const late = waitChip(input({ kind, sinceChangeMs: STILL_WAITING_MS }));
      expect(late.state).toBe('stalled');
      expect(late.label).toBe('Still waiting');
      expect(late.action).toBe('check-again');
      expect(late.icon).not.toBe('spinner');
    }
  });

  test('Settled says what finished and has no button', () => {
    const chip = settledChip('Branch updated.');
    expect(chip.state).toBe('settled');
    expect(chip.label).toBe('Settled');
    expect(chip.detail).toBe('Branch updated');
    expect(chip.action).toBeUndefined();
    expect(SETTLED_MS).toBeGreaterThan(0);
  });
});

describe('autoMergeChip wording', () => {
  const waiting = (
    overrides: Partial<AutoMergeInput> = {},
  ): AutoMergeInput => ({
    state: 'waiting',
    message: 'Auto-merge is waiting for checks to finish.',
    draft: false,
    forge: 'forgejo',
    ...overrides,
  });

  test('waiting for checks reads Waiting for CI and offers Disarm', () => {
    const chip = autoMergeChip(waiting({ code: 'checks_pending' }));
    expect(chip?.label).toBe('Waiting for CI');
    expect(chip?.detail).toBe('Merges when CI passes');
    expect(chip?.action).toBe('disarm');
    expect(chip?.tooltip).toBe('Auto-merge is waiting for checks to finish.');
    expect(chip?.icon).not.toBe('spinner');
  });

  test('each waiting reason has its own short label', () => {
    const labels = new Set<string>();
    for (const code of [
      'checks_pending',
      'stacked',
      'rate_limited',
      'not_mergeable',
      '',
    ]) {
      const chip = autoMergeChip(waiting({ code }));
      expect(chip).not.toBeNull();
      expect(words(chip?.label ?? '')).toBeLessThanOrEqual(3);
      expect(chip?.label).not.toMatch(/^Waiting:/);
      labels.add(chip?.label ?? '');
    }
    expect(labels.size).toBe(5);
    expect(
      autoMergeChip(waiting({ code: 'not_mergeable', draft: true }))?.label,
    ).toBe('Waiting for ready');
  });

  // #1505: with nothing left to wait for, Forgejo's app merges on its next
  // refresh, but GitHub's own auto-merge merges as soon as it can.
  test('a green Forgejo auto-merge merges on the next refresh', () => {
    const chip = autoMergeChip(waiting({ code: '', forge: 'forgejo' }));
    expect(chip?.label).toBe('Merging next');
    expect(chip?.detail).toBe('On the next refresh');
  });

  test('a green GitHub auto-merge says GitHub merges it itself', () => {
    const chip = autoMergeChip(
      waiting({
        code: undefined,
        forge: 'github',
        message: 'Checks passed. GitHub merges it as soon as it can.',
      }),
    );
    expect(chip?.label).toBe('Merging');
    expect(chip?.detail).toBe('GitHub merges it as soon as it can');
    expect(chip?.tooltip).toBe(
      'Checks passed. GitHub merges it as soon as it can.',
    );
  });

  test('a stopped auto-merge is not a wait', () => {
    expect(autoMergeChip(waiting({ state: 'stopped' }))).toBeNull();
  });
});

describe('queuedChip wording', () => {
  test('reads Queued with the reset time, offers Cancel, and is three words at most', () => {
    const chip = queuedChip({
      time: '14:32',
      at: '14:32 CEST',
      verb: 'update',
    });
    expect(chip.label).toBe('Queued · 14:32');
    expect(words(chip.label)).toBeLessThanOrEqual(3);
    expect(chip.action).toBe('cancel');
    expect(chip.resets).toBe(true);
    expect(chip.tooltip).toContain('14:32 CEST');
  });
});

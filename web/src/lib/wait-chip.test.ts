/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { registerForgeCapabilities, resetForgeCapabilities } from './forges';
import {
  type AutoMergeInput,
  armedDetails,
  armedRowChip,
  autoMergeChip,
  autoMergeWording,
  mergeWaitChip,
  queuedChip,
  REVIEW_DECISIONS,
  reviewDecisionOf,
  SETTLED_MS,
  STILL_WAITING,
  STILL_WAITING_MS,
  settledChip,
  settlesOnRow,
  type WaitInput,
  type WaitKind,
  waitChip,
} from './wait-chip';

afterEach(resetForgeCapabilities);

// The chip's wording lives in one module, so the wording is checked here
// without a browser. The page wiring is wait-chip.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/1229

const kinds: WaitKind[] = [
  'bot-rebase',
  'bot-recreate',
  'update-branch',
  'merge',
  'close',
  'reopen',
  'enable-auto-merge',
  'cancel-auto-merge',
  'cancel-bot-rebase',
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

describe('settlesOnRow', () => {
  // A bot rebase, a bot recreate and an Update branch leave the row in place,
  // so they end on Settled. Everything else takes the row off the board or has
  // nothing to settle.
  test('lists exactly the kinds that leave the row in place', () => {
    expect(kinds.filter(settlesOnRow)).toEqual([
      'bot-rebase',
      'bot-recreate',
      'update-branch',
    ]);
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
    expect(chip?.detail).toBe('');
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

  // #3428: the forge won't merge a behind branch here and doesn't update it
  // itself, so the chip says what is being waited for.
  test('a behind branch in a strict repo reads Waiting for update', () => {
    const chip = autoMergeChip(
      waiting({
        code: 'behind',
        forge: 'github',
        message: 'Auto-merge is waiting for the branch to be updated.',
      }),
    );
    expect(chip?.label).toBe('Waiting for update');
    expect(chip?.detail).toBe('The branch must be up to date');
    expect(chip?.action).toBe('disarm');
    expect(chip?.tooltip).toBe(
      'Auto-merge is waiting for the branch to be updated.',
    );
    expect(words(chip?.label ?? '')).toBeLessThanOrEqual(3);
  });

  // #1505: with nothing left to wait for, Forgejo's app merges on its next
  // refresh, but GitHub's own auto-merge merges as soon as it can.
  test('a green Forgejo auto-merge merges on the next refresh', () => {
    const chip = autoMergeChip(waiting({ code: '', forge: 'forgejo' }));
    expect(chip?.label).toBe('Merging next');
    expect(chip?.detail).toBe('On the next refresh');
  });

  // #1596: only a holder the server names changes the Forgejo wording.
  test('a green Forgejo auto-merge held by the forge says the forge merges it', () => {
    const chip = autoMergeChip(
      waiting({
        code: '',
        forge: 'forgejo',
        heldBy: 'forge',
        message: 'Checks passed. Forgejo merges it.',
      }),
    );
    expect(chip?.label).toBe('Merging');
    expect(chip?.detail).toBe('Forgejo merges it when checks pass');
    expect(chip?.tooltip).toBe('Checks passed. Forgejo merges it.');
  });

  test('a green Forgejo auto-merge held by the app or by an unknown holder keeps the historic wording', () => {
    for (const heldBy of ['dashboard', undefined] as const) {
      const chip = autoMergeChip(
        waiting({ code: '', forge: 'forgejo', heldBy }),
      );
      expect(chip?.label).toBe('Merging next');
      expect(chip?.detail).toBe('On the next refresh');
    }
  });

  test('a holder does not change a waiting reason on Forgejo', () => {
    const chip = autoMergeChip(
      waiting({ code: 'checks_pending', heldBy: 'forge' }),
    );
    expect(chip?.label).toBe('Waiting for CI');
  });

  // #4434: on a green pill the server's code is the catch-all, so the page
  // names the hold from the facts the row already carries.
  describe('Waiting for forge says what the forge waits for (#4434)', () => {
    const held = (holds: AutoMergeInput['holds']) =>
      autoMergeChip(waiting({ code: 'not_mergeable', holds }));

    test('a review the forge requires', () => {
      const chip = held({ review: 'review_required' });
      expect(chip?.label).toBe('Waiting for review');
      expect(chip?.detail).toBe('A review is required');
      expect(chip?.action).toBe('disarm');
    });

    test('changes requested wait for a new review', () => {
      const chip = held({ review: 'changes_requested' });
      expect(chip?.label).toBe('Changes requested');
      expect(chip?.detail).toBe('Needs a new review');
    });

    test('a required check nothing has reported is named', () => {
      const chip = held({ pendingChecks: ['lint', 'e2e'] });
      expect(chip?.label).toBe('Waiting for checks');
      expect(chip?.detail).toBe('lint and e2e');
      expect(words(chip?.label ?? '')).toBeLessThanOrEqual(3);
    });

    test('a branch rule', () => {
      const chip = autoMergeChip(waiting({ code: 'blocked_by_protection' }));
      expect(chip?.label).toBe('Waiting for rule');
      expect(chip?.detail).toBe('A branch rule holds it');
      expect(chip?.action).toBe('disarm');
    });

    test('no reason is said plainly and Disarm stays', () => {
      const chip = held(undefined);
      expect(chip?.label).toBe('Waiting for forge');
      expect(chip?.detail).toBe('The forge gave no reason');
      expect(chip?.action).toBe('disarm');
    });

    test('the tooltip adds the reason to the server sentence', () => {
      const chip = held({ review: 'review_required' });
      expect(chip?.tooltip).toBe(
        'Auto-merge is waiting for checks to finish. Forgejo requires a review before it merges.',
      );
    });

    test('a review outranks a check, and a check outranks a rule', () => {
      const both = autoMergeChip(
        waiting({
          code: 'blocked_by_protection',
          holds: { review: 'review_required', pendingChecks: ['lint'] },
        }),
      );
      expect(both?.label).toBe('Waiting for review');
      const checkAndRule = autoMergeChip(
        waiting({
          code: 'blocked_by_protection',
          holds: { pendingChecks: ['lint'] },
        }),
      );
      expect(checkAndRule?.label).toBe('Waiting for check');
    });

    test('an approved or unchecked review names nothing, so a check still shows', () => {
      for (const review of ['approved', 'none'] as const) {
        const chip = held({ review, pendingChecks: ['lint'] });
        expect(chip?.label).toBe('Waiting for check');
      }
    });

    test('a review decision the page does not know is no reason', () => {
      expect(reviewDecisionOf('something_new')).toBeUndefined();
      expect(reviewDecisionOf(undefined)).toBeUndefined();
      const chip = held({ review: reviewDecisionOf('something_new') });
      expect(chip?.label).toBe('Waiting for forge');
      expect(chip?.detail).toBe('The forge gave no reason');
    });

    test('the decisions the page knows are the ones the API documents', () => {
      const yaml = readFileSync(
        new URL('../../../api/openapi.yaml', import.meta.url),
        'utf8',
      );
      const block = yaml.slice(yaml.indexOf('    ReviewState:'));
      const listed = /decision:\s+type: string\s+enum: \[([^\]]+)\]/
        .exec(block)?.[1]
        .split(',')
        .map((v) => v.trim());
      expect([...REVIEW_DECISIONS].map(String).sort()).toEqual(
        [...(listed ?? [])].sort(),
      );
    });

    test('a draft still reads Waiting for ready', () => {
      const chip = autoMergeChip(
        waiting({
          code: 'not_mergeable',
          draft: true,
          holds: { review: 'review_required' },
        }),
      );
      expect(chip?.label).toBe('Waiting for ready');
    });
  });

  test('a GitHub auto-merge ignores the holder', () => {
    const chip = autoMergeChip(
      waiting({ code: '', forge: 'github', heldBy: 'forge' }),
    );
    expect(chip?.detail).toBe('GitHub merges it as soon as it can');
  });

  test('a green GitHub auto-merge says GitHub merges it itself', () => {
    const chip = autoMergeChip(
      waiting({
        code: undefined,
        forge: 'github',
        message: 'Checks passed.',
      }),
    );
    expect(chip?.label).toBe('Merging');
    expect(chip?.detail).toBe('GitHub merges it as soon as it can');
    expect(chip?.tooltip).toBe('Checks passed.');
  });

  test('the tooltip names the forge from its label, not from the server (#4072)', () => {
    registerForgeCapabilities([
      { forge: 'forgejo', capabilities: { label: 'Codeberg' } },
    ]);
    const chip = autoMergeChip(
      waiting({
        code: 'behind',
        forge: 'forgejo',
        message:
          'Auto-merge is waiting for the branch to be updated. The forge requires it to be up to date before it merges.',
      }),
    );
    expect(chip?.tooltip).toBe(
      'Auto-merge is waiting for the branch to be updated. Codeberg requires it to be up to date before it merges.',
    );
  });

  test('a forge that merges itself is named by its label', () => {
    registerForgeCapabilities([
      { forge: 'github', capabilities: { label: 'Octo' } },
    ]);
    const chip = autoMergeChip(waiting({ code: '', forge: 'github' }));
    expect(chip?.detail).toBe('Octo merges it as soon as it can');
  });

  test('a forge that holds its own auto-merge is named by its label', () => {
    registerForgeCapabilities([
      { forge: 'forgejo', capabilities: { label: 'Codeberg' } },
    ]);
    const chip = autoMergeChip(
      waiting({ code: '', forge: 'forgejo', heldBy: 'forge' }),
    );
    expect(chip?.detail).toBe('Codeberg merges it when checks pass');
  });

  test('a status that is neither waiting nor stopped draws no chip', () => {
    expect(
      autoMergeChip({
        state: undefined as unknown as 'waiting',
        code: '',
        message: '',
        draft: false,
        forge: 'github',
      }),
    ).toBeNull();
  });

  test('a stopped auto-merge is a chip that says so, with no button and the whole sentence (#4601)', () => {
    const chip = autoMergeChip(
      waiting({
        state: 'stopped',
        message:
          'Auto-merge stopped: merge conflict. Resolve it on the forge and it carries on.',
      }),
    );
    expect(chip).toMatchObject({
      state: 'stopped',
      icon: 'alert',
      label: 'Auto-merge stopped',
      detail: '',
    });
    expect(chip?.action).toBeUndefined();
    expect(chip?.tooltip).toContain('Resolve it on');
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

describe('autoMergeWording (#4072)', () => {
  test('puts the forge label where the server says "the forge"', () => {
    expect(
      autoMergeWording(
        'Auto-merge stopped: merge conflict. Resolve it on the forge and it carries on.',
        'github',
      ),
    ).toBe(
      'Auto-merge stopped: merge conflict. Resolve it on GitHub and it carries on.',
    );
    expect(
      autoMergeWording(
        'Auto-merge is waiting for the forge to say it can merge.',
        'forgejo',
      ),
    ).toBe('Auto-merge is waiting for Forgejo to say it can merge.');
    expect(
      autoMergeWording(
        'Checks passed. The forge merges it as soon as it can.',
        'github',
      ),
    ).toBe('Checks passed. GitHub merges it as soon as it can.');
  });

  test('a forge with no label is called by its id, and a message without the phrase is untouched', () => {
    expect(autoMergeWording('Resolve it on the forge.', 'sourcehut')).toBe(
      'Resolve it on sourcehut.',
    );
    expect(
      autoMergeWording('Auto-merge is waiting for checks to finish.', 'github'),
    ).toBe('Auto-merge is waiting for checks to finish.');
  });
});

describe('autoMergeChip by capability (#3973)', () => {
  const base = (forge: string): AutoMergeInput => ({
    state: 'waiting',
    code: '',
    message: 'Checks passed.',
    forge,
    draft: false,
  });

  afterEach(() => resetForgeCapabilities());

  test('a forge that does not hold the merge itself says it merges as soon as it can', () => {
    registerForgeCapabilities([
      {
        forge: 'selfmerge',
        capabilities: { label: 'Selfmerge', autoMergeHeldByApp: false },
      },
    ]);
    expect(autoMergeChip(base('selfmerge'))?.detail).toBe(
      'Selfmerge merges it as soon as it can',
    );
  });

  test('a forge whose merge the app holds keeps the next-refresh wording', () => {
    registerForgeCapabilities([
      { forge: 'held', capabilities: { autoMergeHeldByApp: true } },
    ]);
    expect(autoMergeChip(base('held'))?.label).toBe('Merging next');
  });

  test('a forge never described keeps the safe wording', () => {
    expect(autoMergeChip(base('nobody'))?.label).toBe('Merging next');
  });
});
const ODD = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

describe('autoMergeWording forge names', () => {
  test.each(ODD)('a forge named %s is called by its own id', (forge) => {
    expect(autoMergeWording('Waiting for the forge.', forge)).toBe(
      `Waiting for ${forge}.`,
    );
  });
});

describe('autoMergeChip forge names', () => {
  test.each(ODD)('a forge named %s is called by its own id', (forge) => {
    const base = { state: 'waiting', code: '', forge, message: '' } as never;
    expect(
      autoMergeChip({ ...(base as object), heldBy: 'forge' } as never)?.detail,
    ).toBe(`${forge} merges it when checks pass`);
    registerForgeCapabilities([
      { forge, capabilities: { autoMergeHeldByApp: false } },
    ]);
    expect(autoMergeChip(base)?.detail).toBe(
      `${forge} merges it as soon as it can`,
    );
  });
});

describe('mergeWaitChip', () => {
  test('an unarmed CI wait is the Waiting for CI chip that offers Auto-merge', () => {
    const chip = mergeWaitChip('ci');
    expect(chip.label).toBe('Waiting for CI');
    expect(chip.detail).toBe('');
    expect(chip.state).toBe('waiting');
    expect(chip.action).toBe('arm');
    expect(chip.tooltip).toContain('Auto-merge');
  });

  test('the conflict check reads as its own short label', () => {
    const chip = mergeWaitChip('conflict-check');
    expect(chip.label).toBe('Checking for conflicts');
    expect(chip.detail).toBe('');
    expect(chip.action).toBe('arm');
  });

  test('a refresh keeps the long explanation in the tooltip, not the row', () => {
    const chip = mergeWaitChip('refresh');
    expect(chip.label).toBe('Waiting for the forge');
    expect(chip.detail).toBe('');
    expect(chip.tooltip).toBe(
      "Updating from the latest CI results. Still locked after a refresh? The forge counts a check the pipeline doesn't list. Open the pull request on the forge to see it.",
    );
  });

  test('a refresh names the check the forge waits on when the server says which', () => {
    const chip = mergeWaitChip('refresh', false, true, ['deploy/gate']);
    expect(chip.label).toBe('Waiting for the forge');
    expect(chip.tooltip).toBe(
      "The forge is waiting on deploy/gate, a check the pipeline doesn't list. Merge unlocks when it reports.",
    );
  });

  test('a refresh names several checks, in the order the server sent them', () => {
    const chip = mergeWaitChip('refresh', false, true, ['a', 'b', 'c']);
    expect(chip.tooltip).toContain('a, b and c');
  });

  test('a refresh with no names keeps the pointer to the forge', () => {
    expect(mergeWaitChip('refresh', false, true, []).tooltip).toContain(
      'Open the pull request on the forge',
    );
  });

  test('a status the forge has not reported is a wait, with Auto-merge inside', () => {
    const chip = mergeWaitChip('status-unknown');
    expect(chip.label).toBe('Status unknown');
    expect(chip.state).toBe('waiting');
    expect(chip.detail).toBe('');
    expect(chip.action).toBe('arm');
    expect(chip.tooltip).toBe(
      "The forge hasn't said yet whether it merges cleanly. Merge unlocks once it does, or turn on Auto-merge to merge it then.",
    );
  });

  test('past two minutes the unknown status says Still waiting and points at the forge', () => {
    const chip = mergeWaitChip('status-unknown-late');
    expect(chip.label).toBe('Still waiting');
    expect(chip.detail).toBe('Over 2 min');
    expect(chip.state).toBe('stalled');
    expect(chip.action).toBe('arm');
    expect(chip.tooltip).toContain('Open the pull request on the forge');
  });

  test('both Still waiting chips share one label, detail, icon and state', () => {
    const stalled = waitChip(
      input({ kind: 'merge', sinceChangeMs: STILL_WAITING_MS }),
    );
    const late = mergeWaitChip('status-unknown-late');
    for (const chip of [stalled, late]) {
      expect(chip.label).toBe(STILL_WAITING.label);
      expect(chip.detail).toBe(STILL_WAITING.detail);
      expect(chip.icon).toBe(STILL_WAITING.icon);
      expect(chip.state).toBe(STILL_WAITING.state);
    }
  });

  test('an unknown status the row cannot arm never mentions Auto-merge', () => {
    for (const wait of ['status-unknown', 'status-unknown-late'] as const)
      expect(mergeWaitChip(wait, false, false).tooltip).not.toMatch(
        /auto-merge/i,
      );
  });

  test('a row that cannot arm never tells the person to turn on Auto-merge', () => {
    for (const wait of ['ci', 'conflict-check'] as const) {
      const chip = mergeWaitChip(wait, false, false);
      expect(chip.tooltip).not.toMatch(/auto-merge/i);
      expect(chip.tooltip).toContain('Merge unlocks when');
    }
    expect(mergeWaitChip('ci', false, false).tooltip).toBe(
      'CI is still running. Merge unlocks when it passes.',
    );
  });

  test('an armed row offers Cancel auto-merge in the same chip', () => {
    expect(mergeWaitChip('refresh', true).action).toBe('disarm');
    expect(mergeWaitChip('refresh', true).label).toBe('Waiting for the forge');
  });
});

// #4971: the row draws one short word, so the pills beside the chip never
// shrink. The rest of the chip is its tooltip and the details dialog.
describe('armedRowChip', () => {
  const chipOf = (over: Partial<AutoMergeInput> = {}) => {
    const chip = autoMergeChip({
      state: 'waiting',
      code: 'checks_pending',
      message: 'Auto-merge is waiting for the checks to finish.',
      draft: false,
      forge: 'github',
      ...over,
    });
    if (!chip) throw new Error('no chip');
    return chip;
  };

  test.each([
    ['checks_pending', 'Auto-merge on'],
    ['stacked', 'Auto-merge on'],
    ['behind', 'Auto-merge on'],
    ['rate_limited', 'Auto-merge on'],
    ['blocked_by_protection', 'Auto-merge on'],
    ['', 'Merging'],
  ])('a %p wait draws %p and no detail', (code, label) => {
    const row = armedRowChip(chipOf({ code }));
    expect(row.label).toBe(label);
    expect(row.detail).toBe('');
  });

  test('a merge this app holds reads Merging too', () => {
    const row = armedRowChip(chipOf({ code: '', forge: 'forgejo' }));
    expect(row.label).toBe('Merging');
  });

  test('a stopped auto-merge reads Stopped and stays stopped', () => {
    const row = armedRowChip(chipOf({ state: 'stopped' }));
    expect(row.label).toBe('Stopped');
    expect(row.state).toBe('stopped');
    expect(row.icon).toBe('alert');
  });

  test('the tooltip keeps the label, the detail and the server sentence', () => {
    const full = chipOf({ code: '', message: 'Checks passed.' });
    expect(armedRowChip(full).tooltip).toBe(
      `${full.label}: ${full.detail}. Checks passed.`,
    );
  });

  test('a chip with no detail leads with its label alone', () => {
    expect(armedRowChip(chipOf()).tooltip).toBe(
      'Waiting for CI. Auto-merge is waiting for the checks to finish.',
    );
  });

  test('a message that starts with the label is not led by it twice', () => {
    const chip = chipOf({
      state: 'stopped',
      message: 'Auto-merge stopped: a check failed.',
    });
    expect(armedRowChip(chip).tooltip).toBe(
      'Auto-merge stopped: a check failed.',
    );
    expect(
      armedRowChip({ ...chip, detail: 'Blocked, CI is failing' }).tooltip,
    ).toBe('Auto-merge stopped: a check failed. Blocked, CI is failing.');
  });

  test('the dialog gets the label, the detail and the message apart', () => {
    const chip = chipOf({ code: 'stacked', message: 'Merges later.' });
    expect(armedDetails(chip)).toEqual([
      'Waiting for parent',
      'Merges after its parent.',
      'Merges later.',
    ]);
    expect(armedDetails(chipOf())).toEqual([
      'Waiting for CI',
      'Auto-merge is waiting for the checks to finish.',
    ]);
  });
});

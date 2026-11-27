/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { factsOf } from './check-facts-fixture';
import {
  blockingFirst,
  CHECK_STATE_LABELS,
  type Check,
  checkDurationSeconds,
  checkRunKey,
  checkState,
  checkUnknownWord,
  footerRunLink,
  formatCheckDuration,
  groupChecks,
  isBlocking,
  rerunnableCounts,
  runLinkNoun,
  runLinkText,
  runPageUrl,
} from './pipeline-checks';

const check = (over: Partial<Check>): Check => ({
  name: 'build',
  status: 'completed',
  conclusion: 'success',
  url: '',
  ...over,
});

describe('formatCheckDuration', () => {
  test('seconds alone under a minute', () => {
    expect(formatCheckDuration(42)).toBe('42s');
  });

  test('minutes and seconds under an hour', () => {
    expect(formatCheckDuration(125)).toBe('2m 5s');
  });

  test('hours and minutes from an hour up', () => {
    expect(formatCheckDuration(3700)).toBe('1h 1m');
  });
});

describe('CHECK_STATE_LABELS', () => {
  test('words an unknown check as Unknown', () => {
    expect(CHECK_STATE_LABELS.unknown).toBe('Unknown');
  });

  test('names every state a check can be in', () => {
    expect(Object.keys(CHECK_STATE_LABELS).sort()).toEqual([
      'awaiting_approval',
      'cancelled',
      'failure',
      'not_reported',
      'queued',
      'running',
      'skipped',
      'success',
      'timed_out',
      'unknown',
    ]);
  });
});

describe('isBlocking', () => {
  test('a required check that failed, timed out or is held blocks', () => {
    for (const state of ['failure', 'timed_out', 'awaiting_approval']) {
      expect(isBlocking(check({ required: true, ...factsOf(state) }))).toBe(
        true,
      );
    }
  });

  test('an advisory, unknown or healthy check does not', () => {
    expect(
      isBlocking(
        check({ required: false, status: 'completed', conclusion: 'failure' }),
      ),
    ).toBe(false);
    expect(
      isBlocking(check({ status: 'completed', conclusion: 'failure' })),
    ).toBe(false);
    expect(
      isBlocking(
        check({ required: true, status: 'completed', conclusion: 'success' }),
      ),
    ).toBe(false);
  });
});

describe('blockingFirst', () => {
  test('moves blocking checks up and keeps the forge order otherwise', () => {
    const a = check({ name: 'a' });
    const b = check({
      name: 'b',
      required: true,
      status: 'completed',
      conclusion: 'failure',
    });
    const c = check({ name: 'c' });
    const d = check({
      name: 'd',
      required: true,
      status: 'completed',
      conclusion: 'timed_out',
    });

    expect(blockingFirst([a, b, c, d]).map((x) => x.name)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });
});

describe('groupChecks', () => {
  test('one flat list when the forge said nothing about required', () => {
    const list = [check({ name: 'a' }), check({ name: 'b' })];

    expect(groupChecks(list)).toEqual([{ id: '', title: '', checks: list }]);
  });

  test('Required, Advisory and Not known if required, each only when it has checks', () => {
    const req = check({ name: 'r', required: true });
    const adv = check({ name: 'a', required: false });
    const unk = check({ name: 'u' });

    expect(groupChecks([unk, adv, req])).toEqual([
      { id: 'pipeline-group-required', title: 'Required', checks: [req] },
      { id: 'pipeline-group-advisory', title: 'Advisory', checks: [adv] },
      {
        id: 'pipeline-group-unknown',
        title: 'Not known if required',
        hint: "The forge didn't say whether these block the merge.",
        checks: [unk],
      },
    ]);
    expect(groupChecks([req]).map((g) => g.title)).toEqual(['Required']);
  });

  test('no checks, no groups', () => {
    expect(groupChecks([])).toEqual([]);
  });
});

describe('checkDurationSeconds', () => {
  const at = (start: string, end?: string) =>
    check({ startedAt: start, completedAt: end });

  test('works the duration out from the two timestamps', () => {
    expect(
      checkDurationSeconds(at('2026-10-03T10:00:00Z', '2026-10-03T10:01:30Z')),
    ).toBe(90);
  });

  test('a job that ends the moment it starts ran for zero seconds', () => {
    expect(
      checkDurationSeconds(at('2026-10-03T10:00:00Z', '2026-10-03T10:00:00Z')),
    ).toBe(0);
  });

  test('counts the same span whatever the offset the dates carry', () => {
    expect(
      checkDurationSeconds(
        at('2026-10-03T12:00:00+02:00', '2026-10-03T10:01:30Z'),
      ),
    ).toBe(90);
  });

  test('says nothing while the job has no end', () => {
    expect(checkDurationSeconds(at('2026-10-03T10:00:00Z'))).toBeUndefined();
    expect(checkDurationSeconds(check({}))).toBeUndefined();
  });

  test('says nothing for an end before the start or a bad date', () => {
    expect(
      checkDurationSeconds(at('2026-10-03T10:01:00Z', '2026-10-03T10:00:00Z')),
    ).toBeUndefined();
    expect(checkDurationSeconds(at('nope', 'nah'))).toBeUndefined();
  });
});

describe('checkRunKey', () => {
  test('changes with the attempt and with the end time', () => {
    const a = check({
      url: 'u',
      runAttempt: 1,
      startedAt: '2026-10-03T10:00:00Z',
      completedAt: '2026-10-03T10:00:05Z',
    });

    expect(checkRunKey({ ...a, runAttempt: 2 })).not.toBe(checkRunKey(a));
    expect(checkRunKey({ ...a, completedAt: '2026-10-03T10:00:06Z' })).not.toBe(
      checkRunKey(a),
    );
  });

  test('a new end time on the same attempt is a new run', () => {
    const a = check({
      url: 'u',
      runAttempt: 1,
      completedAt: '2026-10-03T10:00:05Z',
    });

    expect(checkRunKey({ ...a, completedAt: '2026-10-03T10:00:09Z' })).not.toBe(
      checkRunKey(a),
    );
  });

  test('keeps the key when a later excerpt arrives and the forge numbers the run', () => {
    const a = check({ url: 'u', runAttempt: 1, excerpt: 'one' });

    expect(checkRunKey({ ...a, excerpt: 'two' })).toBe(checkRunKey(a));
  });

  test('falls back to the excerpt when the forge gives neither attempt nor duration', () => {
    const a = check({ url: 'u', excerpt: 'first failure' });

    expect(checkRunKey({ ...a, excerpt: 'second failure' })).not.toBe(
      checkRunKey(a),
    );
    expect(checkRunKey({ ...a })).toBe(checkRunKey(a));
  });
});

describe('runPageUrl', () => {
  test('trims a GitHub job page to its run page', () => {
    const checks = [
      check({ url: 'https://github.com/o/r/actions/runs/123/job/456' }),
    ];
    expect(runPageUrl(checks)).toEqual({
      url: 'https://github.com/o/r/actions/runs/123',
      kind: 'run',
    });
  });

  test('trims a Forgejo job page to its run page', () => {
    const checks = [
      check({ url: 'https://f.example/o/r/actions/runs/7/jobs/2' }),
    ];
    expect(runPageUrl(checks)).toEqual({
      url: 'https://f.example/o/r/actions/runs/7',
      kind: 'run',
    });
  });

  test('several jobs of one run are still one run', () => {
    const checks = [
      check({ url: 'https://f.example/o/r/actions/runs/7/jobs/2' }),
      check({ url: 'https://f.example/o/r/actions/runs/7/jobs/3' }),
    ];
    expect(runPageUrl(checks)?.kind).toBe('run');
  });

  test('several runs link the newest failed run, named as such', () => {
    const checks = [
      check({
        conclusion: 'failure',
        url: 'https://f.example/o/r/actions/runs/7/jobs/2',
      }),
      check({ url: 'https://f.example/o/r/actions/runs/9/jobs/0' }),
    ];
    expect(runPageUrl(checks)).toEqual({
      url: 'https://f.example/o/r/actions/runs/7',
      kind: 'failed-run',
    });
  });

  test('several runs with several failed ones link the newest of those', () => {
    const checks = [
      check({
        conclusion: 'timed_out',
        url: 'https://f.example/o/r/actions/runs/5/jobs/2',
      }),
      check({
        conclusion: 'failure',
        url: 'https://f.example/o/r/actions/runs/7/jobs/2',
      }),
      check({ url: 'https://f.example/o/r/actions/runs/9/jobs/0' }),
    ];
    expect(runPageUrl(checks)).toEqual({
      url: 'https://f.example/o/r/actions/runs/7',
      kind: 'failed-run',
    });
  });

  test('an older failed run still wins over a newer passing re-run', () => {
    const checks = [
      check({
        conclusion: 'failure',
        url: 'https://f.example/o/r/actions/runs/7/jobs/2',
      }),
      check({ url: 'https://f.example/o/r/actions/runs/9/jobs/0' }),
    ];
    expect(runPageUrl(checks)).toEqual({
      url: 'https://f.example/o/r/actions/runs/7',
      kind: 'failed-run',
    });
  });

  test('several runs with nothing failed link the newest, named latest', () => {
    const checks = [
      check({ url: 'https://f.example/o/r/actions/runs/7/jobs/2' }),
      check({ url: 'https://f.example/o/r/actions/runs/9/jobs/0' }),
    ];
    expect(runPageUrl(checks)).toEqual({
      url: 'https://f.example/o/r/actions/runs/9',
      kind: 'latest-run',
    });
  });

  const job = (run: number, over: Partial<Check> = {}) =>
    check({ url: `https://f.example/o/r/actions/runs/${run}/jobs/0`, ...over });
  const running = { status: 'in_progress', conclusion: undefined };
  const queued = { status: 'queued', conclusion: undefined };
  const held = { status: 'waiting', conclusion: undefined };
  const page = (run: number) => `https://f.example/o/r/actions/runs/${run}`;

  test('a running run wins over newer finished and queued ones', () => {
    const checks = [job(5, running), job(7, queued), job(9)];
    expect(runPageUrl(checks)).toEqual({
      url: page(5),
      kind: 'running-run',
    });
  });

  test('several running runs link the newest of those', () => {
    const checks = [job(5, running), job(7, running), job(9)];
    expect(runPageUrl(checks)).toEqual({
      url: page(7),
      kind: 'running-run',
    });
  });

  test('a run counts as running when any of its jobs is', () => {
    const checks = [job(5), job(5, running), job(5, queued), job(9)];
    expect(runPageUrl([...checks])).toEqual({
      url: page(5),
      kind: 'running-run',
    });
  });

  test.each([
    ['queued', queued],
    ['held for approval', held],
  ])('a %s run wins over a newer finished one', (_, state) => {
    expect(runPageUrl([job(5, state), job(9)])).toEqual({
      url: page(5),
      kind: 'waiting-run',
    });
  });

  test('a failed run still wins over a running one', () => {
    const checks = [job(5, { conclusion: 'failure' }), job(9, running)];
    expect(runPageUrl(checks)).toEqual({
      url: page(5),
      kind: 'failed-run',
    });
  });

  test('is undefined for a third-party status or no checks', () => {
    const third = [check({ url: 'https://ci.example/build/1' })];
    expect(runPageUrl(third)).toBeUndefined();
    expect(runPageUrl([check({ url: '' })])).toBeUndefined();
    expect(runPageUrl([])).toBeUndefined();
  });
});

describe('footerRunLink', () => {
  const board = 'https://f.example/o/r/actions/runs/9';
  const job = (run: number, over: Partial<Check> = {}) =>
    check({ url: `https://f.example/o/r/actions/runs/${run}/jobs/0`, ...over });

  test('checks naming several runs outrank the board address', () => {
    const checks = [
      job(5, { status: 'in_progress', conclusion: undefined }),
      job(9),
    ];
    expect(footerRunLink(board, checks)).toEqual({
      url: 'https://f.example/o/r/actions/runs/5',
      kind: 'running-run',
    });
  });

  test('the board address stands for one run or none', () => {
    const url = 'https://f.example/o/r/commit/abc/checks';
    expect(footerRunLink(url, [job(5)])).toEqual({ url, kind: 'run' });
    expect(footerRunLink(url, [])).toEqual({ url, kind: 'run' });
  });

  test('with no board address the checks name the run', () => {
    expect(footerRunLink(undefined, [job(5)])).toEqual({
      url: 'https://f.example/o/r/actions/runs/5',
      kind: 'run',
    });
    expect(footerRunLink(undefined, [])).toBeUndefined();
  });

  // A failed listed status names no run, so no run link reaches it (#5101).
  const status = check({
    name: 'deploy',
    url: 'https://ci.example.com/deploy/1',
    conclusion: 'failure',
  });

  test('links a failed check that names no run when no run failed', () => {
    const expected = { url: status.url, kind: 'failed-check' as const };
    expect(footerRunLink(undefined, [status])).toEqual(expected);
    expect(footerRunLink(board, [job(5), status])).toEqual(expected);
    expect(footerRunLink(board, [job(5), job(9), status])).toEqual(expected);
  });

  test('a run with a failed check outranks a failed check without one', () => {
    const one = [job(5, { conclusion: 'failure' }), status];
    expect(footerRunLink(undefined, one)).toEqual({
      url: 'https://f.example/o/r/actions/runs/5',
      kind: 'run',
    });
    expect(footerRunLink(board, [...one, job(9)])?.kind).toBe('failed-run');
  });

  test('a failed check with no address changes nothing', () => {
    const bare = check({ url: '', conclusion: 'failure' });
    expect(footerRunLink(board, [bare])).toEqual({ url: board, kind: 'run' });
  });

  // A failed branch's address may be the only link to the failure, as the list
  // can leave it out.
  const failure = 'https://ci.example.com/build/1';

  test('a failed branch keeps its address when no listed run failed', () => {
    expect(footerRunLink(board, [job(5), job(9)], failure)).toEqual({
      url: failure,
      kind: 'run',
    });
    const app = check({
      url: 'https://app.example/check/1',
      conclusion: 'failure',
    });
    expect(footerRunLink(board, [job(5), app], failure)).toEqual({
      url: failure,
      kind: 'run',
    });
  });

  test('a failed run a failed branch lists still wins', () => {
    const checks = [job(5, { conclusion: 'failure' }), job(9)];
    expect(footerRunLink(board, checks, failure)).toEqual({
      url: 'https://f.example/o/r/actions/runs/5',
      kind: 'failed-run',
    });
  });
});

describe('runLinkText', () => {
  test('names the forge for a run, and not for a check page', () => {
    expect(runLinkText('run', 'GitHub')).toBe('Open run on GitHub');
    expect(runLinkText('failed-check', 'GitHub')).toBe(
      'Open failed check page',
    );
  });
});

describe('runLinkNoun', () => {
  test('names what each kind opens', () => {
    expect(runLinkNoun('run')).toBe('run');
    expect(runLinkNoun('failed-run')).toBe('latest failed run');
    expect(runLinkNoun('running-run')).toBe('latest running run');
    expect(runLinkNoun('waiting-run')).toBe('latest waiting run');
    expect(runLinkNoun('latest-run')).toBe('latest run');
  });
});

describe('checkState', () => {
  const cases: [Partial<Check>, string][] = [
    [{ status: 'queued', conclusion: undefined }, 'queued'],
    [{ status: 'in_progress', conclusion: undefined }, 'running'],
    [{ status: 'waiting', conclusion: undefined }, 'awaiting_approval'],
    [{ status: 'completed', conclusion: 'success' }, 'success'],
    [{ status: 'completed', conclusion: 'failure' }, 'failure'],
    [{ status: 'completed', conclusion: 'cancelled' }, 'cancelled'],
    [{ status: 'completed', conclusion: 'skipped' }, 'skipped'],
    [{ status: 'completed', conclusion: 'timed_out' }, 'timed_out'],
    [{ status: 'completed', conclusion: 'neutral' }, 'success'],
    [{ status: 'completed', conclusion: 'stale' }, 'failure'],
    [{ status: 'completed', conclusion: 'startup_failure' }, 'failure'],
    [
      { status: 'completed', conclusion: 'action_required' },
      'awaiting_approval',
    ],
    [{ status: 'completed', conclusion: 'something_new' }, 'unknown'],
    [{ status: 'completed', conclusion: undefined }, 'unknown'],
    [{ status: 'unknown', conclusion: undefined }, 'unknown'],
    [{ status: 'something_new', conclusion: undefined }, 'unknown'],
  ];

  for (const [over, state] of cases) {
    test(`${over.status} ${over.conclusion ?? ''} reads as ${state}`, () => {
      expect(checkState(check(over))).toBe(state);
    });
  }

  test('a required check nothing reported is its own state', () => {
    expect(checkState({ status: 'queued', notReported: true })).toBe(
      'not_reported',
    );
  });

  test('a conclusion before the status says completed is ignored', () => {
    expect(
      checkState(check({ status: 'in_progress', conclusion: 'failure' })),
    ).toBe('running');
  });
});

describe('rerunnableCounts', () => {
  test('counts failed and timed-out checks that name a run', () => {
    const counts = rerunnableCounts([
      check({ conclusion: 'failure', runId: 1 }),
      check({ conclusion: 'timed_out', runId: 2 }),
      check({ conclusion: 'success', runId: 3 }),
    ]);
    expect(counts).toEqual({ rerun: 2, skipped: 0 });
  });

  test('a failed check with no run is skipped, whatever its job id', () => {
    const counts = rerunnableCounts([
      check({ conclusion: 'failure', runId: 1 }),
      check({ conclusion: 'failure', jobId: 7 }),
      check({ conclusion: 'failure' }),
    ]);
    expect(counts).toEqual({ rerun: 1, skipped: 2 });
  });

  test('passed, running and cancelled checks count for nothing', () => {
    const counts = rerunnableCounts([
      check({ conclusion: 'success' }),
      check({ status: 'in_progress', conclusion: undefined }),
      check({ conclusion: 'cancelled' }),
    ]);
    expect(counts).toEqual({ rerun: 0, skipped: 0 });
  });
});

describe('checkUnknownWord', () => {
  test('is the forge word the server sent for an unknown status', () => {
    expect(
      checkUnknownWord(
        check({
          status: 'unknown',
          conclusion: undefined,
          reportedStatus: 'brand_new_status',
        }),
      ),
    ).toBe('brand_new_status');
  });

  test('is the conclusion for a finished job the page cannot grade', () => {
    expect(checkUnknownWord(check({ conclusion: 'something_new' }))).toBe(
      'something_new',
    );
  });

  test('is empty when the forge gave no word', () => {
    expect(
      checkUnknownWord(check({ status: 'unknown', conclusion: undefined })),
    ).toBe('');
    expect(checkUnknownWord(check({ conclusion: undefined }))).toBe('');
  });

  test('is empty for a check the page can grade', () => {
    expect(
      checkUnknownWord(check({ status: 'queued', reportedStatus: 'queued' })),
    ).toBe('');
    expect(checkUnknownWord(check({ conclusion: 'failure' }))).toBe('');
  });

  test('cuts by whole characters, never inside an emoji', () => {
    const word = checkUnknownWord(
      check({ status: 'unknown', reportedStatus: `${'x'.repeat(39)}😀tail` }),
    );

    expect(word).toBe(`${'x'.repeat(39)}😀`);
    expect(word.isWellFormed()).toBe(true);
  });

  test('turns line breaks and control characters into spaces', () => {
    expect(
      checkUnknownWord(
        check({ status: 'unknown', reportedStatus: 'a\nb\u202Ec\u0000d' }),
      ),
    ).toBe('a b c d');
  });

  test('keeps a long word to a readable length', () => {
    expect(
      checkUnknownWord(
        check({ status: 'unknown', reportedStatus: 'x'.repeat(100) }),
      ).length,
    ).toBeLessThanOrEqual(40);
  });
});

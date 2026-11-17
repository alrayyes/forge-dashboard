/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { type CheckCounts, checkSegments } from './check-counts';
import { factsOf } from './check-facts-fixture';
import { registerForgeCapabilities, resetForgeCapabilities } from './forges';
import type { Check } from './pipeline-checks';
import { foldPullRequest, type PullRequestFold } from './pr-fold';

afterEach(resetForgeCapabilities);

function jobs(...states: string[]): Check[] {
  return states.map((state, i) => ({
    name: `job ${i}`,
    url: `https://forge.example/run/${i}`,
    ...factsOf(state),
  }));
}

// The pill a pull request draws is pending, failure or success, with a held
// job as its own flag. The branch fold's statuses map onto that.
describe('foldPullRequest ci', () => {
  const cases: [string, string[], PullRequestFold['ci']][] = [
    ['success', ['success'], 'success'],
    ['skipped beside successes', ['success', 'skipped'], 'success'],
    ['failure', ['failure'], 'failure'],
    ['timed out', ['timed_out'], 'failure'],
    ['failure beside a running job', ['failure', 'running'], 'failure'],
    ['running', ['running'], 'pending'],
    ['waiting', ['queued'], 'pending'],
    ['cancelled beside a job still going', ['cancelled', 'running'], 'pending'],
    ['held alone', ['awaiting_approval'], 'pending'],
    ['held beside a success', ['awaiting_approval', 'success'], 'pending'],
  ];

  for (const [name, states, want] of cases) {
    test(name, () => {
      expect(foldPullRequest('forgejo', jobs(...states))?.ci).toBe(want);
    });
  }
});

// GitHub counts a run held as action_required as a failure in the rollup and
// sets awaitingWorkflowApproval beside it, whatever else the commit has: the
// flag survives a real failure, and a held run beside running jobs is still a
// failure.
describe('foldPullRequest on GitHub, held runs', () => {
  const cases: [string, string[], string, boolean][] = [
    ['held alone', ['awaiting_approval'], 'failure', true],
    [
      'held beside a success',
      ['awaiting_approval', 'success'],
      'failure',
      true,
    ],
    [
      'held beside a running job',
      ['awaiting_approval', 'running'],
      'failure',
      true,
    ],
    [
      'held beside a queued job',
      ['awaiting_approval', 'queued'],
      'failure',
      true,
    ],
    [
      'held beside a failure',
      ['awaiting_approval', 'failure'],
      'failure',
      true,
    ],
    [
      'held beside a cancelled job',
      ['awaiting_approval', 'cancelled'],
      'failure',
      true,
    ],
    ['no held run', ['success'], 'success', false],
    ['a failure with nothing held', ['failure'], 'failure', false],
  ];

  for (const [name, states, ci, awaiting] of cases) {
    test(name, () => {
      const fold = foldPullRequest('github', jobs(...states));

      expect(fold?.ci).toBe(ci as PullRequestFold['ci']);
      expect(fold?.awaiting).toBe(awaiting);
    });
  }
});

// Forgejo never sets awaitingWorkflowApproval: a job waiting to be approved is
// a pending one, and the pill says so without the approval wording.
describe('foldPullRequest on Forgejo, held runs', () => {
  const cases: [string, string[], string][] = [
    ['held alone', ['awaiting_approval'], 'pending'],
    ['held beside a success', ['awaiting_approval', 'success'], 'pending'],
    ['held beside a running job', ['awaiting_approval', 'running'], 'pending'],
    ['held beside a failure', ['awaiting_approval', 'failure'], 'failure'],
  ];

  for (const [name, states, ci] of cases) {
    test(name, () => {
      const fold = foldPullRequest('forgejo', jobs(...states));

      expect(fold?.ci).toBe(ci as PullRequestFold['ci']);
      expect(fold?.awaiting).toBe(false);
    });
  }
});

describe('foldPullRequest other jobs', () => {
  test('a failure beside a cancelled job is a failure', () => {
    expect(foldPullRequest('github', jobs('failure', 'cancelled'))?.ci).toBe(
      'failure',
    );
  });

  test('a status the page does not know is unknown, and not a pass', () => {
    const odd: Check = { name: 'odd', url: '', status: 'pending' };
    const fold = foldPullRequest('forgejo', [odd]);

    expect(fold?.ci).toBe('pending');
    expect(fold?.counts.unknown).toBe(1);
  });
});

// The servers disagree on a run that was only cancelled: GitHub's rollup reads
// it as failed, Forgejo's pull request path as none or success. The branch fold
// reads it as cancelled, and the dialog lists it as Cancelled, so the pill
// follows them while the dialog is open.
describe('foldPullRequest on a cancelled run', () => {
  test('cancelled alone', () => {
    for (const forge of ['github', 'forgejo']) {
      expect(foldPullRequest(forge, jobs('cancelled'))).toEqual({
        ci: 'cancelled',
        awaiting: false,
        counts: {
          passed: 0,
          skipped: 0,
          running: 0,
          waiting: 0,
          failed: 0,
          unknown: 0,
          cancelled: 1,
          held: 0,
        },
      });
    }
  });

  test('cancelled beside a success', () => {
    expect(foldPullRequest('forgejo', jobs('cancelled', 'success'))?.ci).toBe(
      'cancelled',
    );
  });
});

describe('foldPullRequest leaves to the server', () => {
  test('no jobs', () => {
    expect(foldPullRequest('github', [])).toBeNull();
  });
});

describe('foldPullRequest counts', () => {
  test('are the branch fold counts', () => {
    expect(
      foldPullRequest(
        'github',
        jobs('success', 'skipped', 'running', 'queued', 'failure'),
      )?.counts,
    ).toEqual({
      passed: 2,
      skipped: 1,
      running: 1,
      waiting: 1,
      failed: 1,
      unknown: 0,
      cancelled: 0,
      held: 0,
    });
  });
});

// Every job is in exactly one count, so the segments a pill draws add up to the
// jobs its dialog lists, in every mix and on every forge (#4064).
describe('foldPullRequest counts add up to the jobs listed (#4064)', () => {
  const sum = (counts: CheckCounts): number => {
    const segments = checkSegments(counts);
    expect(segments.every((s) => s.n > 0)).toBe(true);

    return segments.reduce((total, s) => total + s.n, 0);
  };

  const cases: [string, string[]][] = [
    ['passed beside a cancelled job', ['success', 'success', 'cancelled']],
    ['a cancelled job beside a running one', ['cancelled', 'running']],
    ['a cancelled job beside a failure', ['cancelled', 'failure', 'success']],
    ['a held job beside a success', ['awaiting_approval', 'success']],
    ['a held job beside a failure', ['awaiting_approval', 'failure']],
    ['a held job beside a cancelled one', ['awaiting_approval', 'cancelled']],
    ['a held job beside a queued one', ['awaiting_approval', 'queued']],
    [
      'skipped beside cancelled and held',
      ['skipped', 'cancelled', 'awaiting_approval'],
    ],
  ];

  for (const [name, states] of cases) {
    test(name, () => {
      for (const forge of ['github', 'forgejo']) {
        const fold = foldPullRequest(forge, jobs(...states));
        expect(sum((fold as PullRequestFold).counts)).toBe(states.length);
      }
    });
  }

  test('a cancelled and a held job have their own counts', () => {
    const fold = foldPullRequest(
      'github',
      jobs('success', 'cancelled', 'awaiting_approval'),
    );

    expect(fold?.counts.cancelled).toBe(1);
    expect(fold?.counts.held).toBe(1);
    expect(fold?.awaiting).toBe(true);
  });

  // Every sequence of up to five jobs drawn from every state a job can be in.
  test('always, for every mix of states', () => {
    const states = [
      'success',
      'skipped',
      'running',
      'queued',
      'failure',
      'timed_out',
      'cancelled',
      'awaiting_approval',
    ];
    const mixes: string[][] = [[]];
    for (let size = 0; size < 5; size++) {
      for (const mix of mixes.filter((m) => m.length === size)) {
        for (const state of states) mixes.push([...mix, state]);
      }
    }

    for (const mix of mixes.filter((m) => m.length > 0)) {
      for (const forge of ['github', 'forgejo']) {
        const fold = foldPullRequest(forge, jobs(...mix));
        expect(sum((fold as PullRequestFold).counts)).toBe(mix.length);
      }
    }
  });
});

// Forgejo leaves a job whose needs failed blocked in the finished run and says
// pending for it. The run's own facts say the run is over, so nothing will
// start that job: it is no wait, and the pill is a plain failure.
describe('foldPullRequest, blocked jobs of a failed run', () => {
  const failedRun = {
    runId: 455,
    runAttempt: 1,
    status: 'completed',
    conclusion: 'failure',
  };
  const inRun = (check: Check, runId = 455, runAttempt = 1): Check => ({
    ...check,
    runId,
    runAttempt,
  });

  test('queued jobs of a failed run are not waiting', () => {
    const checks = [
      inRun(jobs('failure')[0]),
      inRun({ ...jobs('queued')[0], name: 'blocked' }),
    ];
    const fold = foldPullRequest('forgejo', checks, [failedRun]);

    expect(fold?.ci).toBe('failure');
    expect(fold?.counts.waiting).toBe(0);
    expect(fold?.counts.failed).toBe(1);
  });

  test('a queued job of a run still going keeps waiting', () => {
    const going = {
      ...failedRun,
      status: 'in_progress',
      conclusion: undefined,
    };
    const checks = [
      inRun(jobs('failure')[0]),
      inRun({ ...jobs('queued')[0], name: 'next' }),
    ];
    const fold = foldPullRequest('forgejo', checks, [going]);

    expect(fold?.counts.waiting).toBe(1);
  });

  test('a rerun of the run keeps its queued jobs waiting', () => {
    const checks = [
      inRun(jobs('failure')[0]),
      inRun({ ...jobs('queued')[0], name: 'rerun' }, 455, 2),
    ];
    const fold = foldPullRequest('forgejo', checks, [failedRun]);

    expect(fold?.counts.waiting).toBe(1);
  });

  test('a queued job of another run keeps waiting', () => {
    const checks = [
      inRun(jobs('failure')[0]),
      inRun({ ...jobs('queued')[0], name: 'other' }, 456),
    ];
    const fold = foldPullRequest('forgejo', checks, [failedRun]);

    expect(fold?.counts.waiting).toBe(1);
  });

  test('without run facts a queued job waits as before', () => {
    const checks = [inRun(jobs('failure')[0]), inRun(jobs('queued')[0])];

    expect(foldPullRequest('forgejo', checks)?.counts.waiting).toBe(1);
  });

  test('a queued job with no run id is not matched by a run with none', () => {
    const noRun = { status: 'completed', conclusion: 'failure' };
    const checks = [jobs('failure')[0], jobs('queued')[0]];
    const fold = foldPullRequest('forgejo', checks, [noRun]);

    expect(fold?.counts.waiting).toBe(1);
  });
});

describe('foldPullRequest cancelled count (#3395)', () => {
  test('counts the cancelled jobs beside the passed ones', () => {
    const fold = foldPullRequest(
      'forgejo',
      jobs('success', 'success', 'cancelled', 'cancelled', 'cancelled'),
    );

    expect(fold?.ci).toBe('cancelled');
    expect(fold?.counts.passed).toBe(2);
    expect(fold?.counts.cancelled).toBe(3);
  });
});

describe('foldPullRequest by capability (#3974)', () => {
  test('a forge that sets approvalGatedRuns reads a held run as GitHub does', () => {
    registerForgeCapabilities([
      { forge: 'gated', capabilities: { approvalGatedRuns: true } },
    ]);

    const fold = foldPullRequest('gated', jobs('awaiting_approval'));

    expect(fold?.ci).toBe('failure');
    expect(fold?.awaiting).toBe(true);
  });

  test('a forge the page has not heard of reads a held run as pending', () => {
    const fold = foldPullRequest('nobody', jobs('awaiting_approval'));

    expect(fold?.ci).toBe('pending');
    expect(fold?.awaiting).toBe(false);
  });
});

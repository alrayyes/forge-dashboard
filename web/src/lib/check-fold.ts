// Folds a default branch's job facts into the one status and the four counts
// its pill draws. The server sends what each job did (status and conclusion,
// see Check); what that adds up to is decided here, once, so a pill and the
// pipeline dialog that lists the same jobs cannot disagree. No DOM here.
//
// This is the page's copy of the server's branch fold (mainBranchStatus,
// countChecks and tally in internal/forgejo/main_branch.go), kept in step by
// the same cases in check-fold.test.ts.

import type { CheckCounts } from './check-counts';
import { type Check, checkState } from './pipeline-checks';

// What a default branch's pill says. `none` is a branch with no job to fold.
export type BranchStatus =
  | 'none'
  | 'failed'
  | 'running'
  | 'cancelled'
  | 'awaiting_approval'
  | 'passed';

export type BranchFold = {
  status: BranchStatus;
  // Every kind is present, zero when nothing is in it. Skipped is inside
  // passed, as check-counts.ts has it.
  counts: Required<CheckCounts>;
  // The names of the jobs counted as failed, in the order they were listed:
  // what a row's Failing: line says. Empty when none failed.
  failing: string[];
};

// A real failure wins over a job still going; jobs that were only cancelled,
// with nothing left running to replace them, are cancelled: nothing broke. A
// pull request's rollup reads the same jobs differently on purpose, so this is
// the branch's fold alone.
//
// A cancelled job is in none of the four counts, and neither is one held for
// approval, which has a state of its own. A held job outranks passed and
// cancelled ones: the branch is not done until someone approves it. It does
// not outrank a failure or a job going, which say more.
//
// A status the page cannot grade waits, as the server reads it as queued.
// Left out of the port: GitHub counts ACTION_REQUIRED as a failure, while
// checkState reads it as held, for both forges.
export function foldBranch(checks: readonly Check[]): BranchFold {
  const counts: Required<CheckCounts> = {
    passed: 0,
    skipped: 0,
    running: 0,
    waiting: 0,
    failed: 0,
  };
  const failing: string[] = [];
  let cancelled = false;
  let held = false;

  for (const check of checks) {
    switch (checkState(check)) {
      case 'success':
        counts.passed++;
        break;
      case 'skipped':
        counts.passed++;
        counts.skipped++;
        break;
      case 'running':
        counts.running++;
        break;
      case 'failure':
      case 'timed_out':
        counts.failed++;
        failing.push(check.name);
        break;
      case 'cancelled':
        cancelled = true;
        break;
      case 'awaiting_approval':
        held = true;
        break;
      default:
        // queued, and any status checkState cannot grade
        counts.waiting++;
    }
  }

  return {
    status: statusOf(counts, { cancelled, held }, checks.length),
    counts,
    failing,
  };
}

function statusOf(
  counts: Required<CheckCounts>,
  { cancelled, held }: { cancelled: boolean; held: boolean },
  total: number,
): BranchStatus {
  if (total === 0) return 'none';
  if (counts.failed > 0) return 'failed';
  if (counts.running > 0 || counts.waiting > 0) return 'running';
  if (held) return 'awaiting_approval';
  if (cancelled) return 'cancelled';

  return 'passed';
}

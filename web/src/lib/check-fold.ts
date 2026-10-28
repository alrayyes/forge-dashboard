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
  | 'passed';

export type BranchFold = {
  status: BranchStatus;
  // Every kind is present, zero when nothing is in it. Skipped is inside
  // passed, as check-counts.ts has it.
  counts: Required<CheckCounts>;
};

// A real failure wins over a job still going; jobs that were only cancelled,
// with nothing left running to replace them, are cancelled: nothing broke. A
// pull request's rollup reads the same jobs differently on purpose, so this is
// the branch's fold alone.
//
// A cancelled job is in none of the four counts, and neither is one held for
// approval, which has a state of its own. Held jobs are not folded into the
// status yet.
export function foldBranch(checks: readonly Check[]): BranchFold {
  const counts: Required<CheckCounts> = {
    passed: 0,
    skipped: 0,
    running: 0,
    waiting: 0,
    failed: 0,
  };
  let cancelled = false;

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
      case 'queued':
        counts.waiting++;
        break;
      case 'failure':
      case 'timed_out':
        counts.failed++;
        break;
      case 'cancelled':
        cancelled = true;
        break;
    }
  }

  return { status: statusOf(counts, cancelled, checks.length), counts };
}

function statusOf(
  counts: Required<CheckCounts>,
  cancelled: boolean,
  total: number,
): BranchStatus {
  if (total === 0) return 'none';
  if (counts.failed > 0) return 'failed';
  if (counts.running > 0 || counts.waiting > 0) return 'running';
  if (cancelled) return 'cancelled';

  return 'passed';
}

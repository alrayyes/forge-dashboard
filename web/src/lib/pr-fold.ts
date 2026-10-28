// Folds the jobs a pull request's pipeline dialog lists into the pill its row
// draws, so the row and the dialog cannot disagree while the dialog is open.
// It sits on foldBranch's grading of each job and only maps the result onto
// what a pull request's pill says: pending, failure, success or cancelled, the counts,
// and a held job as a flag of its own. No DOM here.

import type { CheckCounts } from './check-counts';
import { foldBranch } from './check-fold';
import { type Check, checkState } from './pipeline-checks';

export type PullRequestFold = {
  ci: 'pending' | 'failure' | 'success' | 'cancelled';
  // The server's awaitingWorkflowApproval: GitHub sets it for any held run.
  // Forgejo never does.
  awaiting: boolean;
  counts: Required<CheckCounts>;
};

// Returns null where there is nothing to fold: no jobs. A row given null keeps
// the pill the server sent.
//
// A run that was only cancelled reads as cancelled, the branch fold's reading
// and the word the dialog uses. The servers disagree on it: GitHub's rollup
// says failed, and Forgejo's pull request path leaves cancelled jobs out of
// the failed count and says none or success. The server's pill therefore
// differs from this one until the dialog opens.
//
// A job held for approval is read as each server reads it:
// - GitHub's rollup counts a held run (action_required) as a failure, so the
//   pill is failure whatever runs beside it, and awaiting is set for any held
//   run, a real failure beside it included.
// - Forgejo has no such flag. A held job is a pending one.
//
// Left to the server: failingOnlyForApproval, which quick filters and
// auto-merge status read from the snapshot while this pill is live.
export function foldPullRequest(
  forge: string,
  checks: readonly Check[],
): PullRequestFold | null {
  const { status, counts } = foldBranch(checks);
  const held = checks.some((c) => checkState(c) === 'awaiting_approval');

  if (forge === 'github' && held) {
    return { ci: 'failure', awaiting: true, counts };
  }

  switch (status) {
    case 'failed':
      return { ci: 'failure', awaiting: false, counts };
    case 'running':
    case 'awaiting_approval':
      return { ci: 'pending', awaiting: false, counts };
    case 'passed':
      return { ci: 'success', awaiting: false, counts };
    case 'cancelled':
      return { ci: 'cancelled', awaiting: false, counts };
    default:
      return null;
  }
}

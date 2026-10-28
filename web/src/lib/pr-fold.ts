// Folds the jobs a pull request's pipeline dialog lists into the pill its row
// draws, so the row and the dialog cannot disagree while the dialog is open.
// It sits on foldBranch's grading of each job and only maps the result onto
// what a pull request's pill says: pending, failure or success, the counts,
// and a held job as a flag of its own. No DOM here.

import type { CheckCounts } from './check-counts';
import { foldBranch } from './check-fold';
import type { Check } from './pipeline-checks';

export type PullRequestFold = {
  ci: 'pending' | 'failure' | 'success';
  // A job is held for approval and nothing worse or livelier outranks it.
  awaiting: boolean;
  counts: Required<CheckCounts>;
};

// Returns null where the page does not decide: no jobs, and a run that was
// only cancelled. The servers disagree on that run. GitHub's rollup reads it
// as failed, Forgejo's pull request path leaves cancelled jobs out of the
// failed count and reads none or success, and the branch fold reads it as
// cancelled. A row given null keeps the pill the server sent.
export function foldPullRequest(
  checks: readonly Check[],
): PullRequestFold | null {
  const { status, counts } = foldBranch(checks);

  switch (status) {
    case 'failed':
      return { ci: 'failure', awaiting: false, counts };
    case 'running':
      return { ci: 'pending', awaiting: false, counts };
    case 'awaiting_approval':
      return { ci: 'pending', awaiting: true, counts };
    case 'passed':
      return { ci: 'success', awaiting: false, counts };
    default:
      return null;
  }
}

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

// The jobs of the newest run of each workflow. A default branch's commit can
// carry many runs of one workflow (a push, then scheduled or dispatched ones),
// and only the newest says whether the code works now: a higher run number, or a
// later attempt of the same run, replaces the older. A run that was only
// cancelled replaces nothing. A job with no workflow name or run number is kept.
// The server drops the same jobs from the row it sends
// (SupersededRuns in internal/dashboard/newest_runs.go); the page does it again
// for jobs that arrive over the stream, so a pill and the list under it agree.
// Both read the same cases, internal/dashboard/testdata/newest_runs.json.
//
// `runs` are the run facts a snapshot row carries. Where a run's conclusion is
// there, it says whether the run was cancelled, as it does on the server.
export function newestRuns(
  checks: readonly Check[],
  runs: readonly RunConclusion[] = [],
): Check[] {
  const cancelled = cancelledRuns(checks, runs);
  const newest = new Map<string, Check>();
  for (const check of checks) {
    if (!check.runName || !check.runNumber || cancelled.has(runKey(check)))
      continue;
    const name = check.runName as string;
    const current = newest.get(name);
    if (!current || isOlder(current, check)) newest.set(name, check);
  }

  return checks.filter((check) => {
    if (!check.runName || !check.runNumber) return true;
    const current = newest.get(check.runName);

    return !current || !isOlder(check, current);
  });
}

const runKey = (check: Check): string =>
  `${check.runName}#${check.runNumber}.${check.runAttempt ?? 0}`;

// What a run concluded, as a snapshot row's runs carry it.
export type RunConclusion = {
  runId?: number;
  runAttempt?: number;
  conclusion?: string;
};

// The runs that were only cancelled. A run whose conclusion is known is
// cancelled when that says so, as on the server; a job of it that finished
// before the cancel does not change that. A run with no conclusion to read (a
// job that arrived over the stream, with no run facts) is cancelled when every
// one of its jobs was.
function cancelledRuns(
  checks: readonly Check[],
  runs: readonly RunConclusion[],
): Set<string> {
  const known = new Map(
    runs
      .filter((run) => run.conclusion)
      .map((run) => [`${run.runId}.${run.runAttempt ?? 0}`, run.conclusion]),
  );
  const decided = new Map<string, boolean>();
  const live = new Set<string>();
  const all = new Set<string>();
  for (const check of checks) {
    const key = runKey(check);
    const conclusion = known.get(`${check.runId}.${check.runAttempt ?? 0}`);
    all.add(key);
    if (conclusion !== undefined) decided.set(key, conclusion === 'cancelled');
    else if (checkState(check) !== 'cancelled') live.add(key);
  }

  return new Set([...all].filter((key) => decided.get(key) ?? !live.has(key)));
}

function isOlder(a: Check, b: Check): boolean {
  const [an, bn] = [a.runNumber ?? 0, b.runNumber ?? 0];

  return an < bn || (an === bn && (a.runAttempt ?? 0) < (b.runAttempt ?? 0));
}

// foldBranch over the newest run of each workflow, as a default branch's pill
// reads its jobs.
export function foldNewestRuns(
  checks: readonly Check[],
  runs: readonly RunConclusion[] = [],
): BranchFold {
  return foldBranch(newestRuns(checks, runs));
}

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

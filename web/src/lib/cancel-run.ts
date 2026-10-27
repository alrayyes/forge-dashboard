// "Cancel run" in the pipeline checks dialog. Neither GitHub nor Forgejo can
// stop one job of a running workflow, so the unit is the run: the dialog groups
// the queued and running jobs under their run, and a cancel names the run and
// the jobs that stop with it. No DOM here.

import { type Check, checkState } from './pipeline-checks';

export type ActiveRun = {
  runId: number;
  // The workflow's name; empty when the forge didn't give one.
  runName: string;
  // The forge's number for the run; 0 when it didn't say.
  runNumber: number;
  // What the person calls the run: its workflow, with the number added when
  // another active run shares the name or it has none. Unique among the runs
  // activeRuns returns, so no two buttons read alike.
  label: string;
  // True for a lone run the forge gave no name: its button reads plain
  // "Cancel run", as a name after the verb would add nothing.
  bare: boolean;
  // The jobs of the run that are still queued or running, which stop with it.
  // Empty when the forge couldn't list the run's jobs.
  jobs: string[];
  // Their job ids, so a later read can tell that these very jobs finished.
  jobIds: number[];
};

export type CancelTarget = { forge: string; fullName: string };

// The runs with something still going, in the order the checks name them. A
// job with no run id (external CI, a legacy status, a finished job) belongs to
// nothing that can be cancelled.
export function activeRuns(checks: Check[]): ActiveRun[] {
  const runs = new Map<number, ActiveRun>();
  for (const check of checks) {
    if (!check.runId) continue;
    const state = checkState(check);
    if (state !== 'running' && state !== 'queued') continue;
    const run = runs.get(check.runId) ?? {
      runId: check.runId,
      runName: check.runName ?? '',
      runNumber: check.runNumber ?? 0,
      label: '',
      bare: false,
      jobs: [],
      jobIds: [],
    };
    // A check with a run id and no job id stands in for a run whose jobs the
    // forge couldn't list (it is named for the run), so it names no job.
    if (check.jobId) {
      run.jobs.push(check.name);
      run.jobIds.push(check.jobId);
    }
    runs.set(check.runId, run);
  }
  const all = [...runs.values()];
  for (const run of all) {
    run.bare = all.length === 1 && !run.runName;
    run.label = labelFor(run, all);
  }
  // A workflow named like another run's numbered label, or two runs the forge
  // numbered alike, would still read the same: the run id is the last resort.
  const taken = all.map((r) => r.label);
  for (const run of all) {
    if (taken.filter((l) => l === run.label).length > 1)
      run.label = `${run.label} (id ${run.runId})`;
  }
  return all;
}

function labelFor(run: ActiveRun, all: ActiveRun[]): string {
  if (all.length === 1) return run.runName || 'this run';
  const repeated = all.filter((r) => r.runName === run.runName).length > 1;
  const base = run.runName || 'run';
  if (!repeated && run.runName) return base;
  return run.runNumber
    ? `${base} #${run.runNumber}`
    : `${base} (id ${run.runId})`;
}

const going = (c: Check) => {
  const state = checkState(c);

  return state === 'running' || state === 'queued';
};

// Whether a later read of the checks shows the run's own jobs finished. A run
// missing from the active runs doesn't say so: GitHub's run lookup can fail and
// leave the same jobs listed as running with no run id. So the jobs themselves
// are looked up, and one still going (or any check naming the run as going)
// means not stopped yet. A job no longer listed was replaced by a newer push,
// so it is over. A stand-in run (no job ids) is the one check named for it; it
// vanishing means its jobs became readable and none is going.
export function runStopped(run: ActiveRun, list: Check[]): boolean {
  // An empty list (an unparseable body reads as one) says nothing about the run.
  if (list.length === 0) return false;
  // Whatever the list now holds for this run, a going check means it runs on:
  // Forgejo may have become able to list a stand-in run's jobs.
  if (list.some((c) => c.runId === run.runId && going(c))) return false;
  if (run.jobIds.length) {
    const byId = new Map(list.filter((c) => c.jobId).map((c) => [c.jobId, c]));
    // A job gone from a newer list (a new push replaced the checks) is over.
    return run.jobIds.every((id) => {
      const check = byId.get(id);
      return check === undefined || !going(check);
    });
  }
  const standIn = list.find((c) => !c.jobId && c.name === run.runName);
  // Gone from the list means its jobs became readable and none is going.
  return standIn === undefined || !going(standIn);
}

// The Cancel button's text: a lone unnamed run needs no name after the verb.
export function cancelText(run: ActiveRun): string {
  return run.bare ? 'Cancel run' : `Cancel run: ${run.label}`;
}

export function runLabel(run: ActiveRun): string {
  return run.label;
}

// Asks the forge to cancel the run. Resolves once it accepted; rejects with the
// forge's own reason when it refused (an ActionRequestError).
export async function cancelRun(
  target: CancelTarget,
  runId: number,
): Promise<void> {
  const res = await fetch('/api/checks/cancel-run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      forge: target.forge,
      fullName: target.fullName,
      runId,
    }),
  });
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('session expired');
  }
  if (res.status === 204) return;
  // Loaded on a refusal only: action-error pulls in the page's reactive time
  // module, which a plain unit test of the happy path has no need of.
  const { readActionFailure } = await import('./action-error');
  throw await readActionFailure(res);
}

// A token that may not write to Actions can't cancel any run of the repository,
// so the rest of its Cancel buttons go too.
export function cancelLocksRepo(error: { code?: string }): boolean {
  return error.code === 'permission';
}

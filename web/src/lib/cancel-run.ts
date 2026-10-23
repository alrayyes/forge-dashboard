// "Cancel run" in the pipeline checks dialog. Neither GitHub nor Forgejo can
// stop one job of a running workflow, so the unit is the run: the dialog groups
// the queued and running jobs under their run, and a cancel names the run and
// the jobs that stop with it. No DOM here.

import type { Check } from './pipeline-checks';

export type ActiveRun = {
  runId: number;
  // The workflow's name; empty when the forge didn't give one.
  runName: string;
  // The jobs of the run that are still queued or running, which stop with it.
  jobs: string[];
};

export type CancelTarget = { forge: string; fullName: string };

// The runs with something still going, in the order the checks name them. A
// job with no run id (external CI, a legacy status, a finished job) belongs to
// nothing that can be cancelled.
export function activeRuns(checks: Check[]): ActiveRun[] {
  const runs = new Map<number, ActiveRun>();
  for (const check of checks) {
    if (!check.runId) continue;
    if (check.state !== 'running' && check.state !== 'queued') continue;
    const run = runs.get(check.runId) ?? {
      runId: check.runId,
      runName: check.runName ?? '',
      jobs: [],
    };
    run.jobs.push(check.name);
    runs.set(check.runId, run);
  }
  return [...runs.values()];
}

export function runLabel(run: ActiveRun): string {
  return run.runName || 'this run';
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

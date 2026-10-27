// What the pipeline dialog needs to draw one check, shared by every board that
// opens it (PipelineDialog.svelte), so a job reads the same on all of them. No
// DOM here.

// Matches components.schemas.Check in api/openapi.yaml: one job/check run, as
// sent in the `checks` events of GET /api/dashboard/stream.
// `required` is absent when the forge couldn't tell, which is not the same as
// false.
export type Check = {
  name: string;
  state: string;
  url: string;
  required?: boolean;
  // When the forge says the job started and finished (RFC 3339); the page
  // works the duration out from them. Absent when the forge doesn't say.
  startedAt?: string;
  completedAt?: string;
  // Which attempt of its run the job is (Forgejo), so a retry reads as new.
  runAttempt?: number;
  failedStep?: string;
  excerpt?: string;
  // The forge's job id, which the output is read by; absent when it has none.
  jobId?: number;
  // The Actions run a queued or running job belongs to, and its workflow's
  // name; absent once the job finished and for a check that isn't an Actions
  // job (external CI), which has nothing to cancel.
  runId?: number;
  runName?: string;
  // The forge's number for that run, which tells two runs of a workflow apart.
  runNumber?: number;
};

// What tells one run of a job from another, for the forge that reuses the job
// id and page when a run is retried. The attempt number and the end time say it
// when the forge gives them. A forge that gives neither leaves the log's own
// tail as the only sign of a rerun that failed again, so that stands in; it
// then also changes when a still-running job's later lines arrive, which only
// costs a copy the person has to press again.
export function checkRunKey(check: Check): string {
  const known =
    check.runAttempt !== undefined || check.completedAt !== undefined;

  return [
    check.url,
    check.completedAt ?? '',
    check.runAttempt ?? '',
    known ? '' : (check.excerpt ?? ''),
  ].join('|');
}

// The per-check status vocabulary of the CheckState enum.
// Distinct from the row-level CI labels, which describe a whole pipeline.
export const CHECK_STATE_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  success: 'Passed',
  failure: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  timed_out: 'Timed out',
  awaiting_approval: 'Waiting for approval',
};

// How long a finished job ran, from the two timestamps the server sends.
// Undefined while it has no end, or when either date is unusable.
export function checkDurationSeconds(check: Check): number | undefined {
  if (!check.startedAt || !check.completedAt) return undefined;
  const ms = Date.parse(check.completedAt) - Date.parse(check.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return undefined;

  return Math.floor(ms / 1000);
}

// 125 -> "2m 5s", 42 -> "42s", 3700 -> "1h 1m": a duration the way a person
// reads it, not a bare second count.
export function formatCheckDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;

  return `${sec}s`;
}

// A required check that failed (or timed out), or a required workflow held for
// approval, is what actually blocks the merge. The dialog flags it in text, not
// colour alone.
export function isBlocking(check: Check): boolean {
  return (
    check.required === true &&
    (check.state === 'failure' ||
      check.state === 'timed_out' ||
      check.state === 'awaiting_approval')
  );
}

// Blocking checks first, once, when the dialog opens. A stable sort, so the
// forge's own order stands otherwise.
export function blockingFirst(checks: Check[]): Check[] {
  return [...checks].sort(
    (a, b) => Number(isBlocking(b)) - Number(isBlocking(a)),
  );
}

const RUN_PAGE = /^(.*\/actions\/runs\/(\d+))(?:\/|$)/;

// The page of the newest Actions run the checks name, for a target that
// carries no run address of its own (a pull request). A job's page is the
// run's page plus a job path, so trimming it names the whole run. A
// third-party status has no run page, and neither does an empty list.
export function runPageUrl(checks: Check[]): string | undefined {
  let newest: { url: string; id: number } | undefined;
  for (const check of checks) {
    const match = RUN_PAGE.exec(check.url);
    if (!match) continue;
    const id = Number(match[2]);
    if (!newest || id > newest.id) newest = { url: match[1], id };
  }
  return newest?.url;
}

export type CheckGroup = { id: string; title: string; checks: Check[] };

// The dialog's sections. Without a single known `required` the forge said
// nothing about branch protection, so the checks stay one flat list (an empty
// id and title). A check with no `required` is never filed under Advisory on a
// guess.
export function groupChecks(checks: Check[]): CheckGroup[] {
  if (checks.length === 0) return [];
  if (!checks.some((check) => check.required !== undefined)) {
    return [{ id: '', title: '', checks }];
  }
  const groups: CheckGroup[] = [
    {
      id: 'pipeline-group-required',
      title: 'Required',
      checks: checks.filter((check) => check.required === true),
    },
    {
      id: 'pipeline-group-advisory',
      title: 'Advisory',
      checks: checks.filter((check) => check.required === false),
    },
    {
      id: 'pipeline-group-unknown',
      title: 'Status unknown',
      checks: checks.filter((check) => check.required === undefined),
    },
  ];

  return groups.filter((group) => group.checks.length > 0);
}

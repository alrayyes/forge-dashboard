// What the pipeline dialog needs to draw one check, shared by every board that
// opens it (PipelineDialog.svelte), so a job reads the same on all of them. No
// DOM here.

// Matches components.schemas.Check in api/openapi.yaml: one job/check run, as
// returned by GET /api/pull-requests/checks and GET /api/main-branches/checks.
// `required` is absent when the forge couldn't tell, which is not the same as
// false.
export type Check = {
  name: string;
  state: string;
  url: string;
  required?: boolean;
  durationSeconds?: number;
  // Which attempt of its run the job is (Forgejo), so a retry reads as new.
  runAttempt?: number;
  failedStep?: string;
  excerpt?: string;
  // The forge's job id, which the output is read by; absent when it has none.
  jobId?: number;
};

// The per-check status vocabulary of the checks endpoints' CheckState enum.
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

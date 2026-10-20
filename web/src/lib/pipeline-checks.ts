// What the pipeline panel needs to draw one check, shared by the pull request
// board's panel (Dashboard.svelte) and the Main branches page's, so a job reads
// the same on both. No DOM here.

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
  failedStep?: string;
  excerpt?: string;
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

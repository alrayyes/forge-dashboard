// What the pipeline dialog needs to draw one check, shared by every board that
// opens it (PipelineDialog.svelte), so a job reads the same on all of them. No
// DOM here.

// Matches components.schemas.Check in api/openapi.yaml: one job/check run, as
// sent in the `run` events of GET /api/v1/dashboard/stream.
// `required` is absent when the forge couldn't tell, which is not the same as
// false.
export type Check = {
  name: string;
  // How far the job got, and once it is completed how it ended. The page
  // grades them into what it shows (checkState).
  status: string;
  conclusion?: string;
  // The forge's own word for a status the server cannot grade; sent only
  // while status is 'unknown'.
  reportedStatus?: string;
  // Why a queued Forgejo job has not started: it needs earlier jobs, or it
  // waits for a runner. Absent for GitHub and for any job not queued.
  waitingFor?: 'jobs' | 'runner';
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
  // A required check nothing on the head has reported: not a job, so no page,
  // no log and no count. The page says which one hasn't reported (#3305).
  notReported?: boolean;
  // The forge's job id, which the output is read by; absent when it has none.
  jobId?: number;
  // The Actions run the job belongs to, and its workflow's name; absent for a
  // check that isn't an Actions job (external CI), which has nothing to
  // cancel.
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

// The one word the page shows and decides on for a check, worked out from the
// two facts the server sends: queued, running, awaiting_approval, or how it
// ended once it is completed. The conclusion is the forge's own word, so this
// is where the page decides what each one means: a neutral job passed, a stale
// or never-started one failed, and a word it doesn't know reads as unknown,
// which is neither a failure nor a pass.
export function checkState(
  check: Pick<Check, 'status' | 'conclusion' | 'notReported'>,
): string {
  if (check.notReported) return 'not_reported';
  switch (check.status) {
    case 'queued':
      return 'queued';
    case 'in_progress':
      return 'running';
    case 'waiting':
      return 'awaiting_approval';
    case 'completed':
      return concludedState(check.conclusion);
    default:
      return 'unknown';
  }
}

function concludedState(conclusion: string | undefined): string {
  switch (conclusion) {
    case 'success':
    case 'neutral':
      return 'success';
    case 'cancelled':
    case 'skipped':
    case 'timed_out':
      return conclusion;
    case 'action_required':
      return 'awaiting_approval';
    case 'failure':
    case 'stale':
    case 'startup_failure':
      return 'failure';
    default:
      // A word the page was not written for, or none: not a failure it can
      // name, and not a pass.
      return 'unknown';
  }
}

// The forge's own word for a check the page shows as unknown, so the dialog
// can name it: the conclusion of a finished job, or the status of one that
// has not finished. Empty when the check is not unknown or the forge gave
// none. Cleaned and cut short, since it is the forge's text.
export function checkUnknownWord(check: Check): string {
  if (checkState(check) !== 'unknown') return '';
  const word =
    check.status === 'completed' ? check.conclusion : check.reportedStatus;

  // Line breaks, control and direction-override characters would reorder or
  // break the row, so they read as spaces. The cut is by whole characters, so
  // an emoji is never split.
  const plain = (word ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .trim();

  return Array.from(plain).slice(0, 40).join('');
}

// The per-check labels, keyed by checkState.
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
  not_reported: 'Not reported',
  unknown: 'Unknown',
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
  const state = checkState(check);

  return (
    check.required === true &&
    (state === 'failure' ||
      state === 'timed_out' ||
      state === 'awaiting_approval' ||
      state === 'not_reported')
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

export type RunLinkKind =
  | 'run'
  | 'failed-run'
  | 'running-run'
  | 'waiting-run'
  | 'latest-run';

export type RunLink = { url: string; kind: RunLinkKind };

// Which of several runs the link opens: the first of these that any run has a
// check in, else the newest run of all. A failed run is what someone opens the
// dialog to debug; failing that, a run still going is what they wait for.
const RUN_PREFERENCE: { kind: RunLinkKind; states: string[] }[] = [
  { kind: 'failed-run', states: ['failure', 'timed_out'] },
  { kind: 'running-run', states: ['running'] },
  { kind: 'waiting-run', states: ['queued', 'awaiting_approval'] },
];

// The run page to link, from the checks alone. A job's page is the run's page
// plus a job path, so trimming it names the run. One run is just "the run".
// Several runs (workflows, a re-run) can't all be opened by one link, so
// RUN_PREFERENCE picks one, the newest where several qualify, and the kind says
// which sort it is. A third-party status has no run page, and neither does an
// empty list.
export function runPageUrl(checks: Check[]): RunLink | undefined {
  const runs = new Map<number, { url: string; states: Set<string> }>();
  for (const check of checks) {
    const match = RUN_PAGE.exec(check.url);
    if (!match) continue;
    const id = Number(match[2]);
    const run = runs.get(id) ?? { url: match[1], states: new Set<string>() };
    run.states.add(checkState(check));
    runs.set(id, run);
  }
  if (runs.size === 0) return undefined;
  const newestFirst = [...runs].sort(([a], [b]) => b - a).map(([, run]) => run);
  if (newestFirst.length === 1) return { url: newestFirst[0].url, kind: 'run' };
  for (const { kind, states } of RUN_PREFERENCE) {
    const run = newestFirst.find((r) => states.some((s) => r.states.has(s)));
    if (run) return { url: run.url, kind };
  }

  return { url: newestFirst[0].url, kind: 'latest-run' };
}

// The dialog's footer link. A board's own run address (a branch's) stands
// while the checks name one run or none. Once they name several, that address
// may be a finished run while another is going, so the checks choose, as they
// do for a pull request. The exception is a failed branch's address
// (failureUrl) when no run the checks name has a failed check: the failure may
// be one the list leaves out, and this link the only way to it.
export function footerRunLink(
  boardUrl: string | undefined,
  checks: Check[],
  failureUrl?: string,
): RunLink | undefined {
  const named = runPageUrl(checks);
  if (failureUrl && named?.kind !== 'failed-run') {
    return { url: failureUrl, kind: 'run' };
  }
  if (named && named.kind !== 'run') return named;

  return boardUrl ? { url: boardUrl, kind: 'run' } : named;
}

// What the link opens, in the words after "Open".
const RUN_LINK_NOUNS: Record<RunLinkKind, string> = {
  run: 'run',
  'failed-run': 'latest failed run',
  'running-run': 'latest running run',
  'waiting-run': 'latest waiting run',
  'latest-run': 'latest run',
};

export function runLinkNoun(kind: RunLinkKind): string {
  return RUN_LINK_NOUNS[kind];
}

// How many failed checks a rerun restarts and how many it leaves out. The
// rerun works per Actions run, so a failed check that names no run (a
// third-party check, a legacy status, an external CI) is skipped. This counts
// only what the dialog shows; the forge can still refuse a run.
export function rerunnableCounts(checks: Check[]): {
  rerun: number;
  skipped: number;
} {
  let rerun = 0;
  let skipped = 0;
  for (const check of checks) {
    const state = checkState(check);
    if (state !== 'failure' && state !== 'timed_out') continue;
    if (check.runId !== undefined && check.runId > 0) rerun++;
    else skipped++;
  }

  return { rerun, skipped };
}

export type CheckGroup = {
  id: string;
  title: string;
  // One generic line under the heading, for a group that needs one.
  hint?: string;
  checks: Check[];
};

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
      title: 'Not known if required',
      hint: "The forge didn't say whether these block the merge.",
      checks: checks.filter((check) => check.required === undefined),
    },
  ];

  return groups.filter((group) => group.checks.length > 0);
}

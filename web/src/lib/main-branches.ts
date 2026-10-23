// What the Main branches page (#1224) knows about GET /api/main-branches:
// the row shape, the local filter, and the small formatters. No DOM here, so
// the page component stays the one place that touches elements.

import type { CheckCounts } from './check-counts';
import type { ForgeHealthEntry } from './forge-lock';
import type { NavCount } from './nav-counts.svelte';

export type MainBranchStatus =
  | 'failed'
  | 'running'
  | 'passed'
  | 'cancelled'
  | 'awaiting_approval'
  | 'none';

export type MainBranchCommit = {
  sha: string;
  subject: string;
  author: string;
  committedAt: string | null;
};

// Matches api/openapi.yaml's MainBranchRelease.
export type MainBranchRelease = {
  tag: string;
  url: string;
};

// Matches api/openapi.yaml's Advisories. `unknown` is no answer, never zero.
export type AdvisorySeverity = 'low' | 'medium' | 'high' | 'critical';
export type AdvisoryReason =
  | 'refused'
  | 'switched_off'
  | 'throttled'
  | 'failed'
  | 'too_many'
  | 'not_enabled';
export type Advisories = {
  state: 'known' | 'unknown';
  // Why the answer is unknown, when the server knows.
  reason?: AdvisoryReason;
  count: number;
  highest?: AdvisorySeverity;
  url?: string;
};

// Matches api/openapi.yaml's MainBranch.
export type MainBranch = {
  forge: string;
  fullName: string;
  url: string;
  branch: string;
  status: MainBranchStatus;
  commit: MainBranchCommit | null;
  failingJobs: string[];
  finishedAt: string | null;
  durationSeconds: number | null;
  runUrl: string;
  checks: CheckCounts;
  latestRelease: MainBranchRelease | null;
  advisories?: Advisories;
  stale: boolean;
  staleSince: string | null;
};

// The count of a status keeps its own name, but awaiting_approval is
// awaitingApproval on the wire, like every other field.
export type MainBranchCounts = Record<
  Exclude<MainBranchStatus, 'awaiting_approval'> | 'awaitingApproval' | 'total',
  number
>;

// What a status pill shows: its status's count, or all of them.
export function statusCount(counts: MainBranchCounts, key: StatusPill): number {
  if (key === 'all') return counts.total;
  if (key === 'awaiting_approval') return counts.awaitingApproval;
  return counts[key];
}

// The Branches nav pill's numbers from the page's own counts, so the pill and
// the chips are one tally however their two reads fall.
export function branchNavCount(counts: MainBranchCounts): NavCount {
  return {
    total: counts.total,
    failed: counts.failed,
    running: counts.running,
    passed: counts.passed,
    none: counts.none,
    awaitingApproval: counts.awaitingApproval,
  };
}

export type MainBranches = {
  generatedAt: string;
  counts: MainBranchCounts;
  forges: ForgeHealthEntry[];
  branches: MainBranch[];
};

export type StatusPill = 'all' | MainBranchStatus;
export type ForgeFilter = 'all' | 'github' | 'forgejo';

// Any row, only rows with open advisories, or only rows known to have none.
// A row whose answer is unknown, or that has none, is under neither of the
// last two: unknown is no answer and never zero.
export type AdvisoryFilter = 'all' | 'has' | 'none';

export type MainBranchFilter = {
  status: StatusPill;
  forge: ForgeFilter;
  advisories: AdvisoryFilter;
  query: string;
};

export const DEFAULT_FILTER: MainBranchFilter = {
  status: 'all',
  forge: 'all',
  advisories: 'all',
  query: '',
};

export const STATUS_LABEL: Record<MainBranchStatus, string> = {
  failed: 'Failed',
  running: 'Running',
  passed: 'Passed',
  cancelled: 'Cancelled',
  awaiting_approval: 'Waiting for approval',
  none: 'No pipeline',
};

// The CI slot draws a running branch as a state and a failed or passed one
// as an outcome, with the pull request row's classes and glyphs (#1563). A
// branch with no pipeline is neither, so it has no entry.
export const CI_SLOT: Partial<
  Record<MainBranchStatus, { cls: string; glyphs: string }>
> = {
  failed: { cls: 'failure', glyphs: 'failure' },
  running: { cls: 'pending', glyphs: 'running' },
  passed: { cls: 'success', glyphs: 'success' },
  cancelled: { cls: 'cancelled', glyphs: 'cancelled' },
  // The pull request row's held run: the failure pill recoloured to the warning
  // pair by .awaiting, with the pause glyph (#1280).
  awaiting_approval: { cls: 'failure awaiting', glyphs: 'awaiting_approval' },
};

// The statuses whose pill says how far the pipeline got (#2074): one that ran,
// failed, passed or still going. A cancelled or held one has its own word.
export const SEGMENTED_STATUSES: ReadonlySet<MainBranchStatus> = new Set([
  'failed',
  'running',
  'passed',
]);

export function isFiltered(filter: MainBranchFilter): boolean {
  return (
    filter.status !== 'all' ||
    filter.forge !== 'all' ||
    filter.advisories !== 'all' ||
    filter.query !== ''
  );
}

// The rows a filter keeps, in the order the server sent them: it already
// puts the newest commit first, and a client sort here would only fight it.
export function applyFilter(
  branches: MainBranch[],
  filter: MainBranchFilter,
): MainBranch[] {
  const query = filter.query.trim().toLowerCase();
  return branches.filter((b) => {
    if (filter.status !== 'all' && b.status !== filter.status) return false;
    if (filter.forge !== 'all' && b.forge !== filter.forge) return false;
    if (filter.advisories !== 'all' && advisoryChoice(b) !== filter.advisories)
      return false;
    if (!query) return true;
    const haystack = [
      b.fullName,
      b.branch,
      b.commit?.sha,
      b.commit?.subject,
      b.commit?.author,
      ...b.failingJobs,
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    return haystack.includes(query);
  });
}

// Which advisory choice a row falls under, or null when its answer is
// unknown or absent: no source reading a repo says nothing about it either.
function advisoryChoice(b: MainBranch): 'has' | 'none' | null {
  if (b.advisories?.state !== 'known') return null;
  return b.advisories.count > 0 ? 'has' : 'none';
}

// How many rows each choice holds, and how many are under neither.
export function advisoryCounts(branches: readonly MainBranch[]) {
  const counts = { has: 0, none: 0, unknown: 0 };
  for (const b of branches) counts[advisoryChoice(b) ?? 'unknown']++;
  return counts;
}

// The advisory choices worth offering, the same way as the forges: those some
// row would show under, given the other filters, plus "Any" and the active one.
export function offeredAdvisories(
  branches: MainBranch[],
  filter: MainBranchFilter,
): Set<AdvisoryFilter> {
  const offered = new Set<AdvisoryFilter>(['all', filter.advisories]);
  for (const b of applyFilter(branches, { ...filter, advisories: 'all' })) {
    const choice = advisoryChoice(b);
    if (choice) offered.add(choice);
  }
  return offered;
}

// The status pills worth offering (#1427): those some row would show if
// clicked, given the forge and the search, plus "All" and the one that is
// active, so it can be seen and cleared.
export function offeredStatuses(
  branches: MainBranch[],
  filter: MainBranchFilter,
): Set<StatusPill> {
  const offered = new Set<StatusPill>(['all', filter.status]);
  for (const b of applyFilter(branches, { ...filter, status: 'all' }))
    offered.add(b.status);
  return offered;
}

// The forge pills worth offering, the same way: given the status and the
// search, plus "All forges" and the one that is active.
export function offeredForges(
  branches: MainBranch[],
  filter: MainBranchFilter,
): Set<ForgeFilter> {
  const offered = new Set<ForgeFilter>(['all', filter.forge]);
  // The API only sends github or forgejo. Another forge would be counted
  // under All forges but get no pill of its own.
  for (const b of applyFilter(branches, { ...filter, forge: 'all' }))
    offered.add(b.forge as ForgeFilter);
  return offered;
}

// Per-forge counts for the toggle, from the rows themselves.
export function forgeCounts(branches: MainBranch[]) {
  return {
    all: branches.length,
    github: branches.filter((b) => b.forge === 'github').length,
    forgejo: branches.filter((b) => b.forge === 'forgejo').length,
  };
}

// "12 min ago", "3 h ago", "2 d ago".
export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// "4m 12s", "1h 03m", "35s".
export function duration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// The filter is saved with the other pages' filters (filters.ts, #1620): a
// `branches` group of plain strings in the shared cookie for the first paint
// and in the server copy for a second browser. These two convert between that
// group and the filter, and a stale or hand-edited value reads as its default.
const STATUSES = [
  'all',
  'failed',
  'running',
  'passed',
  'cancelled',
  'awaiting_approval',
  'none',
];
const FORGES = ['all', 'github', 'forgejo'];
const ADVISORY_CHOICES = ['all', 'has', 'none'];

export function filterFromState(
  saved: Record<string, string> | undefined,
): MainBranchFilter {
  const status = STATUSES.includes(saved?.status ?? '')
    ? (saved?.status as StatusPill)
    : 'all';
  const forge = FORGES.includes(saved?.forge ?? '')
    ? (saved?.forge as ForgeFilter)
    : 'all';
  const advisories = ADVISORY_CHOICES.includes(saved?.advisories ?? '')
    ? (saved?.advisories as AdvisoryFilter)
    : 'all';
  const query =
    typeof saved?.query === 'string' ? saved.query.slice(0, 200) : '';
  return { status, forge, advisories, query };
}

// A link (a release, an advisories page) is shown only for an http(s) url, so
// anything else (javascript:, data:) is never put in a href.
export function httpHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? url
      : null;
  } catch {
    return null;
  }
}

export function filterToState(
  filter: MainBranchFilter,
): Record<string, string> {
  return {
    status: filter.status,
    forge: filter.forge,
    advisories: filter.advisories,
    query: filter.query,
  };
}

export type AdvisoryPill = {
  // The severity, or 'counted' for a count with no severity.
  tone: AdvisorySeverity | 'counted';
  text: string;
  href: string | null;
};

// What the advisories pill on a row says, or null for no pill: no field means
// no source reads this forge, a known zero is not worth an alarm, and an
// unknown answer is said once for the page (advisoryCoverage), not per row.
// The severity is a word, so colour is never the only carrier (WCAG 1.4.1).
export function advisoryPill(a: Advisories | undefined): AdvisoryPill | null {
  if (!a || a.state === 'unknown') return null;
  if (a.count <= 0) return null;
  const noun = a.count === 1 ? 'advisory' : 'advisories';
  const href = a.url ? httpHref(a.url) : null;
  return {
    tone: a.highest ?? 'counted',
    text: a.highest ? `${a.count} ${noun}, ${a.highest}` : `${a.count} ${noun}`,
    href,
  };
}

// How much of one forge's advisory data was readable. 'none': every row that
// has an answer says unknown, so the page shows one notice about the cause.
// 'partial': a mix, so only the unknown rows get a quiet cue. 'full': nothing
// to say. Rows with no field (no source reads that forge) don't count. A
// Forgejo row counts only when its answer is unknown for a stated reason, since
// an unknown with none is usually a repo with no lock file, and `not_enabled`
// means advisories are off for the whole forge.
export type AdvisoryCoverage = 'full' | 'partial' | 'none';
export type AdvisoryForge = 'github' | 'forgejo';

const rowForge = (b: MainBranch): AdvisoryForge =>
  b.forge === 'forgejo' ? 'forgejo' : 'github';

// Whether the row's advisories are unknown in a way the page should say.
export function advisoryRowUnreadable(b: MainBranch): boolean {
  if (b.advisories?.state !== 'unknown') return false;
  if (rowForge(b) === 'github') return true;
  const r = b.advisories.reason;
  return !!r && r !== 'not_enabled';
}

export function advisoryCoverage(
  branches: readonly MainBranch[],
  forge: AdvisoryForge = 'github',
): AdvisoryCoverage {
  let unknown = 0;
  let known = 0;
  for (const b of branches) {
    if (rowForge(b) !== forge || !b.advisories) continue;
    if (advisoryRowUnreadable(b)) unknown++;
    else if (b.advisories.state !== 'unknown') known++;
  }
  if (unknown === 0) return 'full';
  return known === 0 ? 'none' : 'partial';
}

// The one cause every unreadable row of a forge shares, or null when the rows
// disagree or the server named none. The page notice names a cause only when
// it is sure.
export function advisoryUnknownReason(
  branches: readonly MainBranch[],
  forge: AdvisoryForge = 'github',
): Exclude<AdvisoryReason, 'not_enabled'> | null {
  let shared: Exclude<AdvisoryReason, 'not_enabled'> | null = null;
  for (const b of branches) {
    if (rowForge(b) !== forge || !advisoryRowUnreadable(b)) continue;
    const r = b.advisories?.reason;
    if (!r || r === 'not_enabled') return null;
    if (shared && shared !== r) return null;
    shared = r;
  }
  return shared;
}

// What the notice says for a cause. Whether the owner has anything to do
// differs by cause: a rate limit clears by itself, a refusal needs a token.
export const ADVISORY_REASON_TEXT: Record<
  Exclude<AdvisoryReason, 'not_enabled'>,
  string
> = {
  refused:
    'GitHub refused the read: the credential lacks the Dependabot alerts permission (read-only).',
  switched_off:
    "GitHub says Dependabot alerts are switched off on the repository, or the credential can't see it.",
  throttled:
    'GitHub is rate limiting the dashboard. This clears by itself, and no permission needs changing.',
  failed:
    'GitHub returned an error reading the alerts. The dashboard tries again shortly, and no permission needs changing.',
  too_many:
    'A repository has more open alerts than the dashboard reads in one go, so it shows no count rather than a short one.',
};

// What the Forgejo notice says for a cause. Forgejo has no permission to grant:
// advisories come from the lock files through OSV.
export const FORGEJO_ADVISORY_REASON_TEXT: Record<
  Extract<AdvisoryReason, 'failed' | 'too_many'>,
  string
> = {
  failed:
    'OSV could not be reached, or a lock file could not be read or is over 8 megabytes. The dashboard tries again shortly.',
  too_many:
    'A lock file lists more packages, or a repository matches more advisories, than the dashboard reads in one go, so it shows no count rather than a short one.',
};

// The notice text for a shared Forgejo cause, or null when the cause is not one
// Forgejo can report (the caller then falls back to the generic sentence).
export function forgejoAdvisoryReasonText(
  r: AdvisoryReason | null,
): string | null {
  return r === 'failed' || r === 'too_many'
    ? FORGEJO_ADVISORY_REASON_TEXT[r]
    : null;
}

// The hover hint on one unreadable row's cue. GitHub rows keep the plain label.
export function advisoryRowHint(b: MainBranch): string {
  if (rowForge(b) === 'forgejo') {
    const r = b.advisories?.reason;
    if (r === 'failed') return 'Advisories unknown: the read failed';
    if (r === 'too_many') return 'Advisories unknown: too much to read';
  }
  return 'Advisories unknown';
}

// Only a refusal or switched-off alerts are fixed with the permission steps.
export function advisoryReasonNeedsGrant(
  r: Exclude<AdvisoryReason, 'not_enabled'>,
): boolean {
  return r === 'refused' || r === 'switched_off';
}

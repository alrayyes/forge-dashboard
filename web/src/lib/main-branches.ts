// What the Main branches page (#1224) knows about GET /api/main-branches:
// the row shape, the local filter, and the small formatters. No DOM here, so
// the page component stays the one place that touches elements.

export type MainBranchStatus =
  | 'failed'
  | 'running'
  | 'passed'
  | 'cancelled'
  | 'none';

export type MainBranchCommit = {
  sha: string;
  subject: string;
  author: string;
  committedAt: string | null;
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
  stale: boolean;
  staleSince: string | null;
};

export type MainBranchCounts = Record<MainBranchStatus | 'total', number>;

export type MainBranches = {
  generatedAt: string;
  counts: MainBranchCounts;
  branches: MainBranch[];
};

export type StatusPill = 'all' | MainBranchStatus;
export type ForgeFilter = 'all' | 'github' | 'forgejo';

export type MainBranchFilter = {
  status: StatusPill;
  forge: ForgeFilter;
  query: string;
};

export const DEFAULT_FILTER: MainBranchFilter = {
  status: 'all',
  forge: 'all',
  query: '',
};

export const STATUS_LABEL: Record<MainBranchStatus, string> = {
  failed: 'Failed',
  running: 'Running',
  passed: 'Passed',
  cancelled: 'Cancelled',
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
};

export function isFiltered(filter: MainBranchFilter): boolean {
  return (
    filter.status !== 'all' || filter.forge !== 'all' || filter.query !== ''
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
const STATUSES = ['all', 'failed', 'running', 'passed', 'cancelled', 'none'];
const FORGES = ['all', 'github', 'forgejo'];

export function filterFromState(
  saved: Record<string, string> | undefined,
): MainBranchFilter {
  const status = STATUSES.includes(saved?.status ?? '')
    ? (saved?.status as StatusPill)
    : 'all';
  const forge = FORGES.includes(saved?.forge ?? '')
    ? (saved?.forge as ForgeFilter)
    : 'all';
  const query =
    typeof saved?.query === 'string' ? saved.query.slice(0, 200) : '';
  return { status, forge, query };
}

export function filterToState(
  filter: MainBranchFilter,
): Record<string, string> {
  return { status: filter.status, forge: filter.forge, query: filter.query };
}

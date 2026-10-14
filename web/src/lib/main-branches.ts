// What the Main branches page (#1224) knows about GET /api/main-branches:
// the row shape, the local filter, and the small formatters. No DOM here, so
// the page component stays the one place that touches elements.

export type MainBranchStatus = 'failed' | 'running' | 'passed' | 'none';

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
  none: 'No pipeline',
};

export function isFiltered(filter: MainBranchFilter): boolean {
  return (
    filter.status !== 'all' || filter.forge !== 'all' || filter.query !== ''
  );
}

// The rows a filter keeps, in the order the server sent them: it already
// puts failed first, and a client sort here would only fight it.
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

// The filter is kept in a cookie of its own, like the other pages' filters
// (filters.ts), not in the shared one: that cookie's shape is pull request
// and issue state, and a third entity's keys would ride along into every
// page's save for no gain.
const COOKIE = 'forge-board-main-branches';

export function loadFilter(): MainBranchFilter {
  try {
    const match = document.cookie.match(
      new RegExp(`(?:^|; )${COOKIE}=([^;]*)`),
    );
    if (!match) return { ...DEFAULT_FILTER };
    const raw = JSON.parse(decodeURIComponent(match[1]));
    const status = ['all', 'failed', 'running', 'passed', 'none'].includes(
      raw?.status,
    )
      ? raw.status
      : 'all';
    const forge = ['all', 'github', 'forgejo'].includes(raw?.forge)
      ? raw.forge
      : 'all';
    const query = typeof raw?.query === 'string' ? raw.query.slice(0, 200) : '';
    return { status, forge, query };
  } catch {
    return { ...DEFAULT_FILTER };
  }
}

export function saveFilter(filter: MainBranchFilter): void {
  const maxAgeSeconds = 365 * 24 * 60 * 60;
  const value = encodeURIComponent(JSON.stringify(filter));
  // Cookie Store API isn't in Safari yet, and this repo targets more than just Chromium (browser-compat.md).
  // biome-ignore lint/suspicious/noDocumentCookie: see above.
  document.cookie = `${COOKIE}=${value}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

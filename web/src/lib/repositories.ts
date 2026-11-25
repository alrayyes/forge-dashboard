// What the Settings Repositories section works out from the repos the
// dashboard read carries: which rows a filter keeps, what an icon button is
// called, and which repos a bulk button reaches. No DOM here, so the section
// stays the one place that touches elements.

import { forgeIds } from './forges';

export type RepoRow = {
  forge: string;
  fullName: string;
  ignored: boolean;
  ignoredPRs?: boolean;
  ignoredIssues?: boolean;
  autoUpdateBranch: boolean;
  rebaseBots: boolean;
  // Set by the dashboard read; the polling-only filter reads it (#4028).
  hasWebhook?: boolean;
};

export type RepositoriesFilter = {
  // '' is every forge.
  forge: string;
  search: string;
  // Only repos with no confirmed webhook (#4028).
  pollingOnly?: boolean;
  // Which ignore state the list shows; unset is 'active', today's view (#4854).
  ignored?: IgnoredView;
  // The per-repo settings the row toggles change; unset is 'all' (#4857).
  autoUpdate?: ToggleView;
  rebaseBots?: ToggleView;
};

export type ToggleView = 'all' | 'on' | 'off';

export type IgnoredView = 'active' | 'all' | 'only';
export type IgnoreScope = '' | 'prs' | 'issues' | 'both';

export type RepoSortKey = 'forge' | 'fullName';

export const NO_FILTER: RepositoriesFilter = { forge: '', search: '' };

export function filtersAreClear(filter: RepositoriesFilter): boolean {
  return (
    filter.forge === '' &&
    filter.search === '' &&
    !filter.pollingOnly &&
    (filter.ignored ?? 'active') === 'active' &&
    (filter.autoUpdate ?? 'all') === 'all' &&
    (filter.rebaseBots ?? 'all') === 'all'
  );
}

function matchesForge(r: RepoRow, filter: RepositoriesFilter): boolean {
  return !filter.forge || r.forge === filter.forge;
}

function matchesSearch(r: RepoRow, filter: RepositoriesFilter): boolean {
  const needle = filter.search.toLowerCase();
  return !needle || r.fullName.toLowerCase().includes(needle);
}

export const repoKey = (r: Pick<RepoRow, 'forge' | 'fullName'>) =>
  `${r.forge}:${r.fullName}`;

function matchesIgnored(r: RepoRow, filter: RepositoriesFilter): boolean {
  const view = filter.ignored ?? 'active';
  return view === 'all' || (view === 'only') === !!r.ignored;
}

function matchesToggles(r: RepoRow, filter: RepositoriesFilter): boolean {
  const auto = filter.autoUpdate ?? 'all';
  const rebase = filter.rebaseBots ?? 'all';
  return (
    (auto === 'all' || (auto === 'on') === r.autoUpdateBranch) &&
    (rebase === 'all' || (rebase === 'on') === r.rebaseBots)
  );
}

// How many repos the count is out of: those the Ignored view covers, plus any
// kept row, so "shown" never exceeds it and the default view doesn't count
// repos it hides.
export function repoScope(
  repos: RepoRow[],
  filter: RepositoriesFilter,
  keep: ReadonlySet<string> = new Set(),
): number {
  return repos.filter((r) => keep.has(repoKey(r)) || matchesIgnored(r, filter))
    .length;
}

// "Showing 12 of 78 repos", or "Showing all 78 repos" when nothing is cut.
export function repoCountText(shown: number, total: number): string {
  const noun = total === 1 ? 'repo' : 'repos';
  return shown === total
    ? `Showing all ${total} ${noun}`
    : `Showing ${shown} of ${total} ${noun}`;
}

// The repos the table shows. A repo whose key is in `keep` was just toggled,
// so it stays where it is, whatever the ignored view and the Auto-update and
// Rebase bots filters say, until the person refreshes or changes a filter.
export function filterRepos<T extends RepoRow>(
  repos: T[],
  filter: RepositoriesFilter,
  keep: ReadonlySet<string> = new Set(),
): T[] {
  return repos.filter(
    (r) =>
      (keep.has(repoKey(r)) ||
        (matchesIgnored(r, filter) && matchesToggles(r, filter))) &&
      matchesForge(r, filter) &&
      matchesSearch(r, filter) &&
      (!filter.pollingOnly || r.hasWebhook === false),
  );
}

// A forge pill is offered only when a repo would survive the other filters,
// and the picked forge stays so it can be seen and cleared.
export function forgeChoices(
  repos: RepoRow[],
  filter: RepositoriesFilter,
): Set<string> {
  const found = new Set<string>(filter.forge ? [filter.forge] : []);
  for (const r of repos) {
    if (
      matchesIgnored(r, filter) &&
      matchesToggles(r, filter) &&
      matchesSearch(r, filter)
    ) {
      found.add(r.forge);
    }
  }
  // Registry order, then any forge the registry doesn't know.
  const known = forgeIds().filter((f) => found.has(f));
  return new Set([...known, ...[...found].filter((f) => !known.includes(f))]);
}

export function sortRepos<T extends RepoRow>(
  repos: T[],
  key: RepoSortKey,
  dir: 'asc' | 'desc',
): T[] {
  const sign = dir === 'desc' ? -1 : 1;
  return repos.slice().sort((a, b) => {
    const first = a[key].localeCompare(b[key]);
    if (first !== 0) return first * sign;
    return a.fullName.localeCompare(b.fullName) * sign;
  });
}

// The fixed accessible names of the icon buttons. The state is aria-pressed,
// never a word in the name.
export const autoUpdateName = (fullName: string) =>
  `Auto-update on ${fullName}`;
export const rebaseBotsName = (fullName: string) =>
  `Rebase bots on ${fullName}`;
export const ignoreName = (fullName: string) => `Ignore ${fullName}`;

// A control's tooltip: what it does, its state, and what a press does. The
// accessible name stays fixed; this is the sighted hover and focus text.
export const toggleTip = (label: string, on: boolean) =>
  `${label}: ${on ? 'on. Press to turn off' : 'off. Press to turn on'}`;
export const lockedTip = (label: string) =>
  `${label}: off, locked. The reason is below`;
const SCOPE_NOUN: Record<Exclude<IgnoreScope, ''>, string> = {
  prs: 'pull requests',
  issues: 'issues',
  both: 'pull requests and issues',
};

export function ignoreScopeOf(
  r: Pick<RepoRow, 'ignored' | 'ignoredPRs' | 'ignoredIssues'>,
): IgnoreScope {
  if (!r.ignored) return '';
  if (r.ignoredPRs && r.ignoredIssues) return 'both';
  return r.ignoredIssues ? 'issues' : 'prs';
}

// The row's own words for what is ignored, so the state is never colour alone.
export const ignoreScopeWords = (scope: IgnoreScope) =>
  scope ? `Ignored: ${SCOPE_NOUN[scope]}` : '';

export const ignoreTip = (scope: IgnoreScope) =>
  scope
    ? `Ignore: ${SCOPE_NOUN[scope]}. Choose another scope, or turn it off`
    : 'Ignore: off. Choose what to ignore';

export type BulkControl = 'autoUpdate' | 'rebaseBots';

// Every tracked repo on the wrong side of the target state, whatever the
// filters say. A locked repo can't be switched on, so the bulk "on" for rebase
// bots skips it; "off" still reaches every repo that has it.
export function bulkTargets<T extends RepoRow>(
  repos: T[],
  control: BulkControl,
  enable: boolean,
  lockOf: (repo: T) => string | null,
): T[] {
  return repos.filter((r) => {
    if (r.ignored) return false;
    const on = control === 'autoUpdate' ? r.autoUpdateBranch : r.rebaseBots;
    if (on === enable) return false;
    return !(enable && control === 'rebaseBots' && lockOf(r));
  });
}

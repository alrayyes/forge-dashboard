// What the Settings Repositories section works out from the repos the
// dashboard read carries: which rows a filter keeps, what an icon button is
// called, and which repos a bulk button reaches. No DOM here, so the section
// stays the one place that touches elements.

import { forgeIds } from './forges';

export type RepoRow = {
  forge: string;
  fullName: string;
  ignored: boolean;
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
};

export type RepoSortKey = 'forge' | 'fullName';

export const NO_FILTER: RepositoriesFilter = { forge: '', search: '' };

export function filtersAreClear(filter: RepositoriesFilter): boolean {
  return filter.forge === '' && filter.search === '' && !filter.pollingOnly;
}

function matchesForge(r: RepoRow, filter: RepositoriesFilter): boolean {
  return !filter.forge || r.forge === filter.forge;
}

function matchesSearch(r: RepoRow, filter: RepositoriesFilter): boolean {
  const needle = filter.search.toLowerCase();
  return !needle || r.fullName.toLowerCase().includes(needle);
}

// The repos the table shows: ignored ones live in their own disclosure.
export function filterRepos<T extends RepoRow>(
  repos: T[],
  filter: RepositoriesFilter,
): T[] {
  return repos.filter(
    (r) =>
      !r.ignored &&
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
    if (!r.ignored && matchesSearch(r, filter)) found.add(r.forge);
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
// Always "off" until #4854 gives the control an ignored state.
export const IGNORE_TIP = 'Ignore: off. Choose what to ignore';

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

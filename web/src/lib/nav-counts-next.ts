import { firstRefreshPending } from './first-refresh';
import {
  branchNavCount,
  countMainBranches,
  type MainBranch,
} from './main-branches';
import type { NavCounts, ServerNavCounts } from './nav-counts.svelte';

// What the nav counts become when a snapshot arrives (#4318). A snapshot that
// carries counts replaces them. null is the server saying its first refresh is
// still running, so they are unknown again, and so is a snapshot from before
// the first refresh ends, whatever it carries (#4365). undefined is a snapshot that says
// nothing about them, and a link already drawn stays drawn: a count that was
// known is not made unknown by silence.
export function nextNavCounts(
  current: NavCounts | null,
  raw: ServerNavCounts | undefined | null,
  firstRefreshDone: boolean | undefined | null,
  branchRows: readonly MainBranch[] | undefined,
  pageBranches: NavCounts['branches'] | null,
): NavCounts | null {
  if (firstRefreshPending(firstRefreshDone)) return null;
  if (raw === undefined) return current;
  if (raw === null) return null;
  return {
    branches:
      pageBranches ?? branchNavCount(countMainBranches(branchRows ?? [])),
    pullRequests: raw.pullRequests,
    issues: { total: raw.issues.total, failed: 0 },
    releases: raw.releases,
    bots: raw.bots,
  };
}

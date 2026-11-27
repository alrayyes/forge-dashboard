// The menu pills as the rows read right now (#5123). The server counts each
// snapshot (`navCounts`). A pull request whose live job list says something
// else about CI is moved from the number the snapshot put it in to the one its
// row now shows. The answer is always worked out from the server's numbers and
// never from an earlier answer, so a snapshot that catches up, or a row that
// is let go of, can't count a pull request twice. No DOM here.

import type { NavCount, NavCounts } from './nav-counts.svelte';
import type { PullRequestFold } from './pr-fold';
import { pullRequestKey } from './pr-row-watch';

// The facts the snapshot sends about a pull request that say where it was
// counted.
export type CountedPullRequest = {
  forge: string;
  repo: string;
  number: number;
  kind?: string;
  ci: string;
  draft: boolean;
  hidden?: boolean;
  // Failing, and not only because a run waits for approval.
  failingCi?: boolean;
  outOfDate?: boolean;
  greenBehindBase?: boolean;
};

type Page = 'pullRequests' | 'releases' | 'bots';
type State = 'running' | 'failed' | 'passed' | 'cancelled' | 'noChecks' | null;

// null is in the total only: a run held for approval has not failed.
function stateOf(ci: string, failing: boolean): State {
  switch (ci) {
    case 'pending':
      return 'running';
    case 'failure':
      return failing ? 'failed' : null;
    case 'success':
      return 'passed';
    case 'cancelled':
      return 'cancelled';
    case 'none':
      return 'noChecks';
    default:
      return null;
  }
}

function pageOf(kind: string | undefined): Page {
  if (kind === 'release') return 'releases';
  if (kind === 'dependency') return 'bots';

  return 'pullRequests';
}

export function applyLiveCi(
  counts: NavCounts | null,
  pullRequests: readonly CountedPullRequest[],
  live: ReadonlyMap<string, PullRequestFold>,
): NavCounts | null {
  if (!counts || live.size === 0) return counts;

  const moved: Partial<Record<Page, NavCount>> = {};
  for (const pr of pullRequests) {
    const fold = live.get(pullRequestKey(pr));
    // The server counts neither a draft nor a hidden pull request.
    if (!fold || pr.draft || pr.hidden) continue;

    const from = stateOf(pr.ci, pr.failingCi === true);
    // A held run beside a job that really failed is still a failure.
    const to = stateOf(fold.ci, !fold.awaiting || fold.counts.failed > 0);
    if (from === to) continue;

    const page = pageOf(pr.kind);
    const count = moved[page] ?? { ...counts[page] };
    moved[page] = count;
    if (from) count[from] = (count[from] ?? 0) - 1;
    if (to) count[to] = (count[to] ?? 0) + 1;

    // Behind sits beside Passed: a bot pull request behind its base is in it
    // only while it passes.
    if (page === 'bots') {
      const was = pr.greenBehindBase === true;
      const is = to === 'passed' && pr.outOfDate === true;
      count.behind = (count.behind ?? 0) + Number(is) - Number(was);
    }
  }

  return Object.keys(moved).length === 0 ? counts : { ...counts, ...moved };
}

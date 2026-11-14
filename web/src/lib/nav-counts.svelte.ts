import {
  branchNavCount,
  countMainBranches,
  type MainBranch,
} from './main-branches';

// The numbers each nav item shows (#1315): how many items its page lists and
// how many of them are failing. The server counts all but Branches
// (`navCounts` on /api/v1/dashboard, from the same filtered lists the pages show);
// Branches is counted here from the main branch rows the snapshot carries, by
// the function the Main branches page uses. This holds the latest answer. The
// dashboard views set it from each snapshot, and the layout asks once on pages
// that load none. null until it is known, so an item shows no number rather
// than a misleading 0.

// running, passed and cancelled come with the pages that have CI (#1439,
// #1458, #3958, #3967): Branches, Pull requests, Bots and Releases. A branch
// with no pipeline or a pull request with no checks has its own neutral count
// (#3241). Issues carries none of them. Branches also carries `none` (#1531),
// the ones with no pipeline, so its six parts (failed, passed, cancelled,
// running, awaiting approval, none) add up to the total; the other pages
// carry `noChecks` instead.
export type NavCount = {
  total: number;
  failed: number;
  running?: number;
  passed?: number;
  cancelled?: number;
  none?: number;
  noChecks?: number;
  awaitingApproval?: number;
};

export type NavCounts = {
  branches: NavCount;
  pullRequests: NavCount;
  issues: NavCount;
  releases: NavCount;
  bots: NavCount;
};

// components.schemas.NavCounts: Issues has a total only, and Branches is not
// here: the page counts the main branch rows the snapshot carries.
export type ServerNavCounts = {
  pullRequests: NavCount;
  issues: { total: number };
  releases: NavCount;
  bots: NavCount;
};

export const navCounts = $state<{ value: NavCounts | null }>({ value: null });

export function setNavCounts(
  raw: ServerNavCounts | undefined | null,
  branchRows: readonly MainBranch[] | undefined,
  keepPageBranches = false,
) {
  navCounts.value = raw
    ? {
        branches:
          (keepPageBranches && pageBranches) ||
          branchNavCount(countMainBranches(branchRows ?? [])),
        pullRequests: raw.pullRequests,
        issues: { total: raw.issues.total, failed: 0 },
        releases: raw.releases,
        bots: raw.bots,
      }
    : null;
}

// The Branches page reads its own list, which can be a poll newer than the
// layout's last read of the snapshot. It hands the pill its counts so the two
// never disagree, and the layout keeps them (setNavCounts' keepPageBranches)
// until the page is left.
let pageBranches: NavCount | null = null;

export function setBranchNavCount(branches: NavCount | null) {
  pageBranches = branches;
  if (branches && navCounts.value)
    navCounts.value = { ...navCounts.value, branches };
}

// The numbers each nav item shows (#1315): how many items its page lists and
// how many of them are failing. The server counts them (`navCounts` on
// /api/dashboard, from the same filtered lists the pages show); this only
// holds the latest answer. The dashboard views set it from each snapshot, and
// the layout asks once on pages that load none. null until it is known, so an
// item shows no number rather than a misleading 0.

// running and passed come with the pages that have CI (#1439): Pull requests,
// Bots and Releases. A pull request with no checks is in the total only, so
// the four need not add up. Branches and Issues carry neither.
export type NavCount = {
  total: number;
  failed: number;
  running?: number;
  passed?: number;
};

export type NavCounts = {
  branches: NavCount;
  pullRequests: NavCount;
  issues: NavCount;
  releases: NavCount;
  bots: NavCount;
};

// components.schemas.NavCounts: Issues has a total only.
export type ServerNavCounts = {
  branches: NavCount;
  pullRequests: NavCount;
  issues: { total: number };
  releases: NavCount;
  bots: NavCount;
};

export const navCounts = $state<{ value: NavCounts | null }>({ value: null });

export function setNavCounts(raw: ServerNavCounts | undefined | null) {
  navCounts.value = raw
    ? {
        branches: raw.branches,
        pullRequests: raw.pullRequests,
        issues: { total: raw.issues.total, failed: 0 },
        releases: raw.releases,
        bots: raw.bots,
      }
    : null;
}

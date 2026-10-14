// The `navCounts` a mocked /api/dashboard answers with (#1315). The server
// counts them from the lists it serves, split by `kind`; a spec that mocks
// those lists builds the same numbers here so the nav has something to show.
type Mock = { kind?: string; ci?: string };

// A page with CI counts how many are running (pending), failing and passing
// (#1439); a pull request with no checks is in the total only.
const pair = (list: Mock[]) => ({
  total: list.length,
  running: list.filter((p) => p.ci === 'pending').length,
  failed: list.filter((p) => p.ci === 'failure').length,
  passed: list.filter((p) => p.ci === 'success').length,
});

export function navCountsFor(
  pullRequests: unknown[],
  openIssueCount: number,
  branches = { total: 0, failed: 0 },
) {
  const all = pullRequests as Mock[];

  return {
    branches,
    pullRequests: pair(
      all.filter((p) => p.kind !== 'release' && p.kind !== 'dependency'),
    ),
    issues: { total: openIssueCount },
    releases: pair(all.filter((p) => p.kind === 'release')),
    bots: pair(all.filter((p) => p.kind === 'dependency')),
  };
}

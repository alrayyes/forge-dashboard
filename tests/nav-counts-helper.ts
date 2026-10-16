// The `navCounts` a mocked /api/dashboard answers with (#1315). A spec that
// mocks the pull request list builds the numbers here so the nav has something
// to show.
//
// There is no counting rule here (#1341). Which page a pull request lands on and
// which number it raises comes from tests/generated/nav-counts.json, which a Go
// test builds by running the server's own buildNavCounts on every kind, CI state,
// draft and hidden combination, and fails on when the rule or a field name
// changes and the file isn't regenerated. All this adds up what the table says.
import table from './generated/nav-counts.json';

type Mock = {
  kind?: string;
  ci?: string;
  draft?: boolean;
  hidden?: boolean;
};

type Page = {
  total: number;
  running: number;
  failed: number;
  passed: number;
  none?: number;
};

const empty = (): Page => ({ total: 0, running: 0, failed: 0, passed: 0 });

export function navCountsFor(
  pullRequests: unknown[],
  openIssueCount: number,
  branches: Partial<Page> = {},
) {
  const pages: Record<string, Page> = {
    pullRequests: empty(),
    releases: empty(),
    bots: empty(),
  };
  for (const pr of pullRequests as Mock[]) {
    const kind = pr.kind ?? 'regular';
    const ci = pr.ci ?? 'none';
    const row = table.pullRequests.find(
      (r) =>
        r.kind === kind &&
        r.ci === ci &&
        r.draft === Boolean(pr.draft) &&
        r.hidden === Boolean(pr.hidden),
    );
    if (!row)
      throw new Error(
        `nav-counts fixture has no row for kind "${kind}", ci "${ci}": widen the combinations in internal/api/nav_counts_fixture_test.go`,
      );
    if (!row.page) continue;
    const page = pages[row.page];
    page.total++;
    if (row.state !== 'none') page[row.state as keyof Page]++;
  }

  return {
    branches: { ...empty(), none: 0, ...branches },
    pullRequests: pages.pullRequests,
    issues: { total: openIssueCount },
    releases: pages.releases,
    bots: pages.bots,
  };
}

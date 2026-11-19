<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, userEvent } from "storybook/test";
  import RelatedBand from "./RelatedBand.svelte";
  import { closingPills } from "./closing-issues.js";
  import {
    type LinkedPullRequest,
    linkedPills,
    withBoardState,
  } from "./linked-pull-requests.js";
  import { mentionPills } from "./mentioned-issues.js";
  import { relatedBandData } from "./related-band.js";

  const { Story } = defineMeta({
    title: "RelatedBand",
    component: RelatedBand,
  });

  // The band as the dialogs build it: the row builders' own pills, handed
  // over as nodes.
  const REPO = "alrayyes/forge-dashboard";
  const ticket = (
    number: number,
    over: Record<string, unknown> = {},
    repo = REPO,
  ) => ({
    repo,
    number,
    url: `https://example.com/${repo}/issues/${number}`,
    pageUrl: `/issues.html?issue=github/${repo}/${number}`,
    tracked: true,
    ...over,
  });
  const pr = (number: number, over: Partial<LinkedPullRequest> = {}) => ({
    forge: "github",
    repo: REPO,
    number,
    draft: false,
    pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
    ci: "none",
    checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
    awaitingWorkflowApproval: false,
    ...over,
  });
  // A pipeline for the pill, as the page's renderer hands it over.
  const renderCi = (p: LinkedPullRequest) => {
    if (p.ci === "none") return null;
    const badge = document.createElement("span");
    badge.className = "ci-pill";
    badge.textContent = "Running 3";
    return {
      badge,
      label: "Running",
      segments: [{ kind: "passed" as const, n: 3 }],
    };
  };

  const pullRequestBand = (
    closes: ReturnType<typeof ticket>[],
    refs: ReturnType<typeof ticket>[] = [],
    mentions: ReturnType<typeof ticket>[] = [],
  ) =>
    relatedBandData(
      "pull-request",
      { closes, refs: refs.map((r) => ({ ...r })), mentions },
      {
        closes: closingPills("pr", REPO, closes, undefined, () => {}, true),
        refs: closingPills(
          "pr:refs",
          REPO,
          refs.map((r) => ({ ...r, relation: "refs" as const })),
          undefined,
          () => {},
          true,
        ),
        mentions: mentionPills("pr", REPO, mentions, () => {}, true),
      },
    );

  const issueBand = (
    closes: LinkedPullRequest[],
    refs: LinkedPullRequest[] = [],
    mentions: LinkedPullRequest[] = [],
  ) => {
    const row = (
      key: string,
      list: LinkedPullRequest[],
      relation: "closes" | "refs" | "mentions",
    ) =>
      linkedPills(
        key,
        REPO,
        withBoardState(list),
        undefined,
        renderCi,
        () => {},
        relation,
        true,
      );
    return relatedBandData(
      "issue",
      { closes, refs, mentions },
      {
        closes: row("i", closes, "closes"),
        refs: row("i:refs", refs, "refs"),
        mentions: row("i:mentions", mentions, "mentions"),
      },
    );
  };
</script>

<!-- A pull request: what it closes, references and mentions. -->
<Story
  name="Pull request, all rows"
  args={{
    band: pullRequestBand(
      [ticket(138), ticket(131)],
      [ticket(7)],
      [ticket(9), ticket(10, { tracked: false })],
    ),
  }}
  play={async ({ canvasElement }) => {
    const labels = [...canvasElement.querySelectorAll(".related-label")].map(
      (n) => n.textContent,
    );
    await expect(labels).toEqual(["Closes", "Refs", "Mentions"]);
    await expect(
      canvasElement.querySelector(".related-count")?.textContent,
    ).toBe("5");
  }}
/>

<!-- An issue: the pull requests that close, reference and mention it, with a draft and its pipeline. -->
<Story
  name="Issue, all rows with a draft"
  args={{
    band: issueBand(
      [pr(142, { draft: true, ci: "pending" })],
      [pr(13)],
      [pr(20), pr(21)],
    ),
  }}
  play={async ({ canvasElement }) => {
    const name = canvasElement
      .querySelector(".linked-pr")
      ?.getAttribute("aria-label");
    await expect(name).toBe("Closed by: PR #142 · Draft Running 3: 3 passed");
  }}
/>

<!-- A cross-repo item shows its repo before the number, cut short when long. -->
<Story
  name="Cross-repo"
  args={{
    band: pullRequestBand(
      [
        ticket(
          4,
          {},
          "alrayyes/a-very-long-repository-name-for-a-wrapped-pill",
        ),
      ],
      [],
      [],
    ),
  }}
  play={async ({ canvasElement }) => {
    const pill = canvasElement.querySelector(".linked-pr") as HTMLElement;
    await expect(pill.getAttribute("aria-label")).toBe(
      "Closes: alrayyes/a-very-long-repository-name-for-a-wrapped-pill#4, opens the issue",
    );
  }}
/>

<!-- A pull request in another repo keeps its state word, and the repo is its own node. -->
<Story
  name="Issue, cross-repo pull request"
  args={{
    band: issueBand([
      pr(12, { repo: "alrayyes/other", kind: "pullRequest", state: "merged" }),
    ]),
  }}
  play={async ({ canvasElement }) => {
    const pill = canvasElement.querySelector(".linked-pr") as HTMLElement;
    await expect(pill.textContent).toBe("PR alrayyes/other#12 · Merged");
    await expect(pill.firstChild?.textContent).toBe("PR ");
    await expect(pill.querySelector(".linked-pr-repo")?.textContent).toBe(
      "alrayyes/other",
    );
    await expect(pill.querySelector(".linked-pr-number")?.textContent).toBe(
      "#12",
    );
    await expect(pill.lastChild?.textContent).toBe(" · Merged");
  }}
/>

<!-- More than six: six show, then one toggle opens and folds the rest. -->
<Story
  name="Fold"
  args={{
    band: pullRequestBand(Array.from({ length: 8 }, (_, i) => ticket(100 + i))),
  }}
  play={async ({ canvasElement }) => {
    const toggle = canvasElement.querySelector(
      ".related-toggle",
    ) as HTMLButtonElement;
    await expect(canvasElement.querySelectorAll(".linked-pr").length).toBe(6);
    await expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    await expect(canvasElement.querySelectorAll(".linked-pr").length).toBe(8);
    await expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await expect(toggle.textContent).toContain("Show fewer");
  }}
/>

<!-- Nothing related: no band at all. -->
<Story
  name="None"
  args={{ band: { count: 0, rows: [] } }}
  play={async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".related-band")).toBeNull();
  }}
/>

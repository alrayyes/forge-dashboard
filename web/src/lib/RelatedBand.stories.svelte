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
  import { patchPills } from "./patch-pills.js";
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
    const label = p.ci === "success" ? "Passed" : "Running";
    badge.textContent = `${label} 3`;
    return {
      badge,
      label,
      segments: [{ kind: "passed" as const, n: 3 }],
    };
  };

  const pullRequestBand = (
    closes: ReturnType<typeof ticket>[],
    refs: ReturnType<typeof ticket>[] = [],
    mentions: ReturnType<typeof ticket>[] = [],
    // The repositories the dashboard does not track: their pills go to the forge.
    untracked: (repo: string) => boolean = () => false,
  ) =>
    relatedBandData(
      "pull-request",
      { closes, refs: refs.map((r) => ({ ...r })), mentions },
      {
        closes: closingPills(
          "pr",
          REPO,
          closes,
          undefined,
          () => {},
          true,
          untracked,
        ),
        refs: closingPills(
          "pr:refs",
          REPO,
          refs.map((r) => ({ ...r, relation: "refs" as const })),
          undefined,
          () => {},
          true,
          untracked,
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

  // The band the "Patches in place" story shows; its button swaps in a fresh
  // draw of the same pills, one pull request's checks having finished.
  let live = $state.raw(
    issueBand([pr(1, { ci: "pending" }), pr(2, { ci: "pending" })]),
  );
  const finished = () =>
    issueBand([pr(1, { ci: "pending" }), pr(2, { ci: "success" })]);

  // The same for a row of eight, so the last two sit behind the fold, and for
  // a draw that has another pull request.
  const eight = (last: Partial<LinkedPullRequest>) =>
    issueBand(
      Array.from({ length: 8 }, (_, i) =>
        pr(i + 1, { ci: "pending", ...(i === 7 ? last : {}) }),
      ),
    );
  let folded = $state.raw(eight({}));
  let grown = $state.raw(issueBand([pr(1, { ci: "pending" })]));
  let swapped = $state.raw(
    issueBand([pr(1, { ci: "pending" }), pr(2, { ci: "pending" })]),
  );
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
    // Every relation is drawn alike; the row's label says which it is.
    const looks = [...canvasElement.querySelectorAll(".linked-pr")].map((n) => {
      const s = getComputedStyle(n);
      return `${s.backgroundColor} ${s.borderTopStyle} ${s.borderTopColor} ${s.fontStyle}`;
    });
    await expect(new Set(looks).size).toBe(1);
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
    // The word alone takes the Merged purple; the text reads as before (#4406).
    await expect(pill.lastChild?.textContent).toBe("Merged");
    await expect((pill.lastChild as HTMLElement).className).toBe(
      "linked-pr-merged",
    );
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

<!-- Each pill's name leads with the relation and holds the visible text; an untracked repository's pill goes to the forge. No line of its own under a row. -->
<Story
  name="Pull request, pill names"
  args={{
    band: pullRequestBand(
      [ticket(138)],
      [ticket(7, { tracked: false }, "alrayyes/other")],
      [ticket(9)],
      (repo) => repo === "alrayyes/other",
    ),
  }}
  play={async ({ canvasElement }) => {
    const name = (label: string) =>
      canvasElement
        .querySelector(`[role="group"][aria-label="${label}"] .linked-pr`)
        ?.getAttribute("aria-label");
    await expect(name("Closes")).toBe("Closes: #138, opens the issue");
    await expect(name("Refs")).toBe(
      "Refs: alrayyes/other#7, does not close, opens on the forge in a new tab",
    );
    await expect(name("Mentions")).toBe("Mentions: #9, opens the issue");
    await expect(canvasElement.querySelector(".related-hint")).toBeNull();
  }}
/>

<!-- An issue's rows are labelled Closed by and Referenced by, and a pill's name is the label, then the pull request. -->
<Story
  name="Issue, referenced by"
  args={{ band: issueBand([pr(12)], [pr(13)]) }}
  play={async ({ canvasElement }) => {
    const labels = [...canvasElement.querySelectorAll(".related-label")].map(
      (n) => n.textContent,
    );
    await expect(labels).toEqual(["Closed by", "Referenced by"]);
    await expect(
      canvasElement
        .querySelector('[role="group"][aria-label="Referenced by"] .linked-pr')
        ?.getAttribute("aria-label"),
    ).toBe("Referenced by: PR #13 · Open");
    await expect(canvasElement.querySelector(".related-hint")).toBeNull();
  }}
/>

<!-- Six pull requests across the rows: no toggle, the count is the items, and no line of its own under Mentioned by. -->
<Story
  name="Mentioned by, under the fold"
  args={{
    band: issueBand(
      [pr(142, { draft: true, ci: "pending" })],
      [],
      Array.from({ length: 5 }, (_, i) => pr(20 + i)),
    ),
  }}
  play={async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(
        '[role="group"][aria-label="Mentioned by"] .linked-pr',
      ).length,
    ).toBe(5);
    await expect(canvasElement.querySelector(".related-toggle")).toBeNull();
    await expect(
      canvasElement.querySelector(".related-count")?.textContent,
    ).toBe("6");
    await expect(canvasElement.querySelector(".related-hint")).toBeNull();
  }}
/>

<!-- Seven mentions fold to six with a toggle, and still no line of its own. -->
<Story
  name="Mentioned by, seven"
  args={{
    band: issueBand(
      [],
      [],
      Array.from({ length: 7 }, (_, i) => pr(30 + i)),
    ),
  }}
  play={async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(
        '[role="group"][aria-label="Mentioned by"] .linked-pr',
      ).length,
    ).toBe(6);
    await expect(
      canvasElement.querySelector(".related-toggle")?.textContent,
    ).toBe("+1 more");
    await expect(canvasElement.querySelector(".related-hint")).toBeNull();
  }}
/>

<!-- The keyboard opens and folds the rest of a row of eight. -->
<Story
  name="Fold by keyboard"
  args={{
    band: pullRequestBand(Array.from({ length: 8 }, (_, i) => ticket(100 + i))),
  }}
  play={async ({ canvasElement }) => {
    const toggle = canvasElement.querySelector(
      ".related-toggle",
    ) as HTMLButtonElement;
    const pills = () => canvasElement.querySelectorAll(".linked-pr").length;
    await expect(pills()).toBe(6);
    await expect(toggle.textContent).toBe("+2 more");
    await expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.focus();
    await userEvent.keyboard("{Enter}");
    await expect(pills()).toBe(8);
    await expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await expect(toggle.textContent).toBe("Show fewer");
    await expect(toggle.getAttribute("aria-label")).toMatch(/^Show fewer/);

    toggle.focus();
    await userEvent.keyboard(" ");
    await expect(pills()).toBe(6);
    await expect(toggle.getAttribute("aria-expanded")).toBe("false");
  }}
/>

<!-- A pill's hover text leads with the item's title, then what the pill does; an unknown title leaves today's line (#4326). -->
<Story
  name="Pill titles"
  args={{
    band: pullRequestBand(
      [ticket(138, { title: "Show the title on hover" }), ticket(131)],
      [ticket(7, { title: "<b>Not markup</b>" })],
      [ticket(9, { title: "Earlier idea" })],
    ),
  }}
  play={async ({ canvasElement }) => {
    const pills = [
      ...canvasElement.querySelectorAll<HTMLElement>(".linked-pr"),
    ];
    await expect(pills[0].title).toBe(
      "Show the title on hover\nCloses the issue when it merges",
    );
    await expect(pills[1].title).toBe("Closes the issue when it merges");
    await expect(pills[2].title).toBe(
      "<b>Not markup</b>\nReferences the issue, does not close it",
    );
    await expect(pills[3].title).toBe(
      "Earlier idea\nMentioned here, does not close it",
    );
    // The title is text: the tip holds no element.
    const tip = canvasElement.querySelector('[role="tooltip"]') as HTMLElement;
    await expect(tip.children.length).toBe(0);
    // The name still starts with the visible text.
    await expect(pills[0].getAttribute("aria-label")).toBe(
      "Closes: #138, opens the issue",
    );
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

<!-- A pill whose pull request changed is written where it stands: the same element, its text and name new, its neighbour untouched (#4328). -->
<Story
  name="Patches in place"
  play={async ({ canvasElement }) => {
    const pills = () => [...canvasElement.querySelectorAll(".linked-pr")];
    const [first, second] = pills();
    await expect(second.getAttribute("aria-label")).toContain("Running");
    // Whatever the new draw doesn't have is taken off.
    second.setAttribute("data-stale", "1");
    await userEvent.click(
      canvasElement.querySelector("button.change") as Element,
    );
    const [afterFirst, afterSecond] = pills();
    await expect(afterFirst).toBe(first);
    await expect(afterSecond).toBe(second);
    await expect(second.getAttribute("aria-label")).toContain("Passed");
    await expect(second.getAttribute("aria-label")).not.toContain("Running");
    await expect(second.textContent).toContain("Passed");
    await expect(second.hasAttribute("data-stale")).toBe(false);
  }}
>
  {#snippet template()}
    <RelatedBand band={live!} />
    <button type="button" class="change" onclick={() => (live = finished())}>
      Change
    </button>
  {/snippet}
</Story>

<!-- A pill kept behind the fold is written too, so it is right when the fold opens. -->
<Story
  name="Patches a folded pill"
  play={async ({ canvasElement }) => {
    const toggle = canvasElement.querySelector(
      ".related-toggle",
    ) as HTMLButtonElement;
    await expect(canvasElement.querySelectorAll(".linked-pr").length).toBe(6);
    await userEvent.click(
      canvasElement.querySelector("button.change") as Element,
    );
    await expect(canvasElement.querySelector(".related-toggle")).toBe(toggle);
    await userEvent.click(toggle);
    const all = [...canvasElement.querySelectorAll(".linked-pr")];
    await expect(all.length).toBe(8);
    await expect(all[7].getAttribute("aria-label")).toContain("Passed");
    await expect(all[0].getAttribute("aria-label")).toContain("Running");
  }}
>
  {#snippet template()}
    <RelatedBand band={folded!} />
    <button
      type="button"
      class="change"
      onclick={() => (folded = eight({ ci: "success" }))}
    >
      Change
    </button>
  {/snippet}
</Story>

<!-- Another pull request in the draw: the band is replaced, not patched. -->
<Story
  name="Replaces when a pull request is added"
  play={async ({ canvasElement }) => {
    const before = canvasElement.querySelector(".linked-pr");
    await userEvent.click(
      canvasElement.querySelector("button.change") as Element,
    );
    const after = [...canvasElement.querySelectorAll(".linked-pr")];
    await expect(after.length).toBe(2);
    await expect(after[0]).not.toBe(before);
  }}
>
  {#snippet template()}
    <RelatedBand band={grown!} />
    <button
      type="button"
      class="change"
      onclick={() =>
        (grown = issueBand([
          pr(1, { ci: "pending" }),
          pr(2, { ci: "pending" }),
        ]))}
    >
      Change
    </button>
  {/snippet}
</Story>

<!-- The same number of pills but another pull request: not the same pill, so the band is replaced. -->
<Story
  name="Replaces when a pull request is swapped"
  play={async ({ canvasElement }) => {
    const before = [...canvasElement.querySelectorAll(".linked-pr")];
    await userEvent.click(
      canvasElement.querySelector("button.change") as Element,
    );
    const after = [...canvasElement.querySelectorAll(".linked-pr")];
    await expect(after[1]).not.toBe(before[1]);
    await expect(after[1].getAttribute("href")).toContain("/3");
  }}
>
  {#snippet template()}
    <RelatedBand band={swapped!} />
    <button
      type="button"
      class="change"
      onclick={() =>
        (swapped = issueBand([
          pr(1, { ci: "pending" }),
          pr(3, { ci: "pending" }),
        ]))}
    >
      Change
    </button>
  {/snippet}
</Story>

<!-- A patched pill drops a description its new draw no longer has, and keeps its own tip when the new draw names another. -->
<Story
  name="Patches a pill's description"
  play={async () => {
    const draw = (describedBy: string | null, text: string) => {
      const band = document.createElement("div");
      const pill = document.createElement("a");
      pill.className = "linked-pr";
      pill.setAttribute("href", "/pr/1");
      if (describedBy) pill.setAttribute("aria-describedby", describedBy);
      pill.textContent = text;
      band.append(pill);
      return band;
    };
    const pillOf = (band: HTMLElement) =>
      band.querySelector(".linked-pr") as HTMLElement;

    const dropped = draw("tip-old", "old");
    const before = pillOf(dropped);
    await expect(patchPills(dropped, draw(null, "new"))).toBe(true);
    await expect(pillOf(dropped)).toBe(before);
    await expect(before.textContent).toBe("new");
    await expect(before.hasAttribute("aria-describedby")).toBe(false);

    const kept = draw("tip-old", "old");
    await expect(patchPills(kept, draw("tip-new", "new"))).toBe(true);
    await expect(pillOf(kept).textContent).toBe("new");
    await expect(pillOf(kept).getAttribute("aria-describedby")).toBe("tip-old");
  }}
>
  {#snippet template()}
    <p>Pills with and without a description.</p>
  {/snippet}
</Story>

<!-- Pills with no address and no id can't be matched, so nothing is patched. -->
<Story
  name="Does not patch pills it cannot tell apart"
  play={async () => {
    const draw = (text: string) => {
      const band = document.createElement("div");
      for (const label of ["a", "b"]) {
        const pill = document.createElement("span");
        pill.className = "linked-pr";
        pill.textContent = `${label} ${text}`;
        band.append(pill);
      }
      return band;
    };
    const current = draw("old");
    await expect(patchPills(current, draw("new"))).toBe(false);
    await expect(current.textContent).toBe("a oldb old");
  }}
>
  {#snippet template()}
    <p>No pills with an address.</p>
  {/snippet}
</Story>

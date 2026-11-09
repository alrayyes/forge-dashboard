<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, userEvent, waitFor } from "storybook/test";
  import { mockFetch } from "../../.storybook/mock-fetch";
  import type { AdvisoryList } from "./advisories-dialog.js";
  import AdvisoriesDialog from "./AdvisoriesDialog.svelte";

  const { Story } = defineMeta({
    title: "AdvisoriesDialog",
    component: AdvisoriesDialog,
    parameters: { layout: "fullscreen" },
  });

  const ROUTE = /\/api\/v1\/main-branches\/advisories/;
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString();

  const GITHUB: AdvisoryList = {
    state: "known",
    url: "https://github.com/alrayyes/forge-dashboard/security/dependabot",
    advisories: [
      {
        number: 41,
        state: "open",
        severity: "critical",
        summary: "Prototype pollution in minimist",
        ghsaId: "GHSA-xvch-5gv4-984h",
        cveId: "CVE-2021-44906",
        package: "minimist",
        ecosystem: "npm",
        scope: "runtime",
        relationship: "transitive",
        manifestPath: "bun.lock",
        openedAt: daysAgo(12),
        vulnerableVersions: "< 1.2.6",
        patchedVersion: "1.2.6",
        cvss: {
          score: 9.8,
          vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
        },
        weaknesses: [{ id: "CWE-1321", name: "Prototype Pollution" }],
        description:
          "Minimist before 1.2.6 is vulnerable to **prototype pollution** through `constructor` and `__proto__` keys.\n\nUpgrade to 1.2.6 or later.",
        references: [
          "https://github.com/advisories/GHSA-xvch-5gv4-984h",
          "https://nvd.nist.gov/vuln/detail/CVE-2021-44906",
        ],
        epss: { percentage: 0.0143, percentile: 0.78 },
        url: "https://github.com/alrayyes/forge-dashboard/security/dependabot/41",
      },
      {
        number: 38,
        state: "open",
        severity: "high",
        summary: "Denial of service in markdown-it",
        ghsaId: "GHSA-6vfc-qv3f-vr6c",
        package: "markdown-it",
        ecosystem: "npm",
        scope: "runtime",
        relationship: "direct",
        manifestPath: "web/package.json",
        openedAt: daysAgo(5),
        vulnerableVersions: ">= 13.0.0, < 14.1.1",
        patchedVersion: "14.1.1",
        cvss: { score: 7.5 },
      },
      {
        number: 35,
        state: "open",
        severity: "medium",
        summary: "Regular expression denial of service in semver",
        package: "semver",
        ecosystem: "npm",
        scope: "development",
        relationship: "transitive",
        manifestPath: "bun.lock",
        openedAt: daysAgo(30),
        patchedVersion: "7.5.2",
      },
      {
        number: 29,
        state: "open",
        severity: "low",
        summary: "Information exposure in a build tool",
        package: "tmp",
        ecosystem: "npm",
        scope: "development",
        relationship: "transitive",
        manifestPath: "bun.lock",
        openedAt: daysAgo(90),
      },
    ],
  };

  const FORGEJO: AdvisoryList = {
    state: "known",
    advisories: [
      {
        number: 1,
        state: "open",
        severity: "high",
        summary: "Out-of-bounds read in golang.org/x/net",
        id: "GO-2024-2687",
        cveId: "CVE-2023-45288",
        package: "golang.org/x/net",
        ecosystem: "Go",
        manifestPath: "go.mod",
        openedAt: daysAgo(3),
        vulnerableVersions: "< 0.23.0",
        patchedVersion: "0.23.0",
      },
    ],
  };

  const REPO = {
    forge: "github",
    fullName: "alrayyes/forge-dashboard",
    branch: "main",
  };

  const opened = async (canvasElement: HTMLElement) => {
    await userEvent.click(
      canvasElement.querySelector("#open-advisories") as HTMLElement,
    );
    await waitFor(() =>
      expect(document.querySelector("dialog[open]")).not.toBeNull(),
    );
  };
</script>

<script lang="ts">
  let github = $state<AdvisoriesDialog>();
  let forgejo = $state<AdvisoriesDialog>();
</script>

{#snippet opener(forge: "github" | "forgejo")}
  <!-- The control that opens the dialog; focus returns to it on close. -->
  <button
    type="button"
    id="open-advisories"
    onclick={(e) => {
      const target = { ...REPO, forge, opener: e.currentTarget };
      (forge === "github" ? github : forgejo)?.open(target);
    }}>Show advisories</button
  >
  {#if forge === "github"}
    <AdvisoriesDialog bind:this={github} />
  {:else}
    <AdvisoriesDialog bind:this={forgejo} />
  {/if}
{/snippet}

<!-- The dialog is closed: only its opener is on the page. -->
<Story asChild name="Closed">{@render opener("github")}</Story>

<!-- The read is still going. -->
<Story
  asChild
  name="Loading"
  beforeEach={() => mockFetch([{ match: ROUTE, hang: true }])}
  play={async ({ canvasElement }) => opened(canvasElement)}
>
  {@render opener("github")}
</Story>

<!-- Open advisories across all four severities. -->
<Story
  asChild
  name="Open list"
  beforeEach={() => mockFetch([{ match: ROUTE, body: GITHUB }])}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".adv-row")).not.toBeNull(),
    );
  }}
>
  {@render opener("github")}
</Story>

<!-- Narrowed to the critical ones. -->
<Story
  asChild
  name="Filtered to critical"
  beforeEach={() => mockFetch([{ match: ROUTE, body: GITHUB }])}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".adv-row")).not.toBeNull(),
    );
    await userEvent.click(
      document.querySelector(
        '[data-testid="advisory-filter-critical"]',
      ) as HTMLElement,
    );
  }}
>
  {@render opener("github")}
</Story>

<!-- One advisory opened: the description, the score and the references. -->
<Story
  asChild
  name="Advisory detail"
  beforeEach={() => mockFetch([{ match: ROUTE, body: GITHUB }])}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".adv-row")).not.toBeNull(),
    );
    await userEvent.click(document.querySelector(".adv-row") as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector(".adv-description")).not.toBeNull(),
    );
  }}
>
  {@render opener("github")}
</Story>

<!-- Keyboard focus lands on Back when a detail opens. -->
<Story
  asChild
  name="Detail focus on Back"
  beforeEach={() => mockFetch([{ match: ROUTE, body: GITHUB }])}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".adv-row")).not.toBeNull(),
    );
    await userEvent.click(document.querySelector(".adv-row") as HTMLElement);
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector(".adv-back")),
    );
  }}
>
  {@render opener("github")}
</Story>

<!-- A repository with no open advisories. -->
<Story
  asChild
  name="Empty"
  beforeEach={() =>
    mockFetch([{ match: ROUTE, body: { state: "known", advisories: [] } }])}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="advisories-empty"]'),
      ).not.toBeNull(),
    );
  }}
>
  {@render opener("github")}
</Story>

<!-- Private packages were left out, so the list is partial. -->
<Story
  asChild
  name="Partial list"
  beforeEach={() =>
    mockFetch([{ match: ROUTE, body: { ...GITHUB, partial: true } }])}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="advisories-partial"]'),
      ).not.toBeNull(),
    );
  }}
>
  {@render opener("github")}
</Story>

<!-- The forge refused the read: the dialog says why. -->
<Story
  asChild
  name="Unreadable"
  beforeEach={() =>
    mockFetch([
      {
        match: ROUTE,
        body: { state: "unknown", reason: "refused", advisories: [] },
      },
    ])}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="advisories-unknown"]'),
      ).not.toBeNull(),
    );
  }}
>
  {@render opener("github")}
</Story>

<!-- The request failed: an alert and Try again. -->
<Story
  asChild
  name="Request failed"
  beforeEach={() =>
    mockFetch([
      { match: ROUTE, status: 502, body: { error: "GitHub did not answer." } },
    ])}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".adv-error")).not.toBeNull(),
    );
  }}
>
  {@render opener("github")}
</Story>

<!-- A Forgejo repository: OSV matches against a lock file. -->
<Story
  asChild
  name="Forgejo list"
  beforeEach={() => mockFetch([{ match: ROUTE, body: FORGEJO }])}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".adv-row")).not.toBeNull(),
    );
  }}
>
  {@render opener("forgejo")}
</Story>

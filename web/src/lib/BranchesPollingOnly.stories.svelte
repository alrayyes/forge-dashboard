<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, userEvent, waitFor, within } from "storybook/test";
  import { mockFetch } from "../../.storybook/mock-fetch";
  // The page under test is a route; it is mounted from src/lib so it sits
  // beside the other stories.
  import BranchesPage from "../routes/(app)/+page.svelte";
  import type { MainBranch, MainBranches } from "./main-branches";
  import {
    dashboardRead,
    resetDashboardRead,
  } from "./dashboard-read.svelte.js";

  const { Story } = defineMeta({
    title: "BranchesPollingOnly",
    component: BranchesPage,
    parameters: { layout: "fullscreen" },
  });

  const repo = (name: string, hasWebhook: boolean) => ({
    forge: "github",
    fullName: `demo/${name}`,
    url: `https://example.com/demo/${name}`,
    hasWebhook,
    canManageWebhooks: hasWebhook,
    ignored: false,
    ignoredPRs: false,
    ignoredIssues: false,
    autoUpdateBranch: false,
    rebaseBots: false,
  });

  const branch = (name: string): MainBranch => ({
    forge: "github",
    fullName: `demo/${name}`,
    url: `https://example.com/demo/${name}`,
    branch: "main",
    status: "passed",
    commit: {
      sha: "d98f3c2",
      subject: "fix: a change",
      author: "dev",
      committedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
    failingJobs: [],
    finishedAt: null,
    durationSeconds: null,
    runUrl: `https://example.com/demo/${name}/actions/runs/1`,
    checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
    latestRelease: null,
    staleSince: null,
    advisories: { state: "unknown", count: 0 },
  });

  const rows = [branch("live"), branch("poll")];

  // Typed as the API's answer, so a field the type gains is a check error here.
  const page = (): MainBranches => ({
    generatedAt: new Date().toISOString(),
    forges: [{ forge: "github", reachable: true }],
    branches: rows,
  });
</script>

<!-- "Show only these" narrows the list to the polling repos. When the last
     one gets a hook the pill is gone, so the filter lets go and every row is
     back instead of an empty list with no way out (#4786, #4805). The shared
     dashboard read is latched in the real app, so the story hands the page a
     new answer the way the layout's read would. -->
<Story
  name="The filter lets go when the last polling repo gets a hook"
  beforeEach={() => {
    resetDashboardRead();
    dashboardRead.state = "answered";
    dashboardRead.data = {
      repos: [repo("live", true), repo("poll", false)],
      firstRefreshDone: true,
    };
    const restore = mockFetch([
      {
        match: /^\/api\/v1\/main-branches$/,
        body: page(),
      },
      // The page's other requests: filter-state saves and the check stream.
      { match: /^\/api\/v1\/settings\/filter-state$/, status: 204 },
      { match: /^\/api\/v1\/dashboard\/stream\/watch$/, status: 204 },
    ]);
    return () => {
      restore();
      resetDashboardRead();
    };
  }}
  play={async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const list = () => canvas.queryAllByTestId("main-branch-row");
    await waitFor(() => expect(list()).toHaveLength(2));
    const pill = canvas.getByRole("button", { name: "Show only these" });
    await step("narrows to the polling repo", async () => {
      await userEvent.click(pill);
      await waitFor(() => expect(list()).toHaveLength(1));
      await expect(list()[0]).toHaveTextContent("demo/poll");
    });
    await step("lets go when the count drops to 0", async () => {
      dashboardRead.data = {
        repos: [repo("live", true), repo("poll", true)],
        firstRefreshDone: true,
      };
      await waitFor(() => expect(list()).toHaveLength(2));
      await expect(canvas.queryByTestId("polling-only-notice")).toBeNull();
      await expect(canvas.queryByTestId("no-match")).toBeNull();
    });
    await step("stays off if a polling repo comes back", async () => {
      dashboardRead.data = {
        repos: [repo("live", true), repo("poll", false)],
        firstRefreshDone: true,
      };
      const back = await canvas.findByRole("button", {
        name: "Show only these",
      });
      await expect(back).toHaveAttribute("aria-pressed", "false");
      await expect(list()).toHaveLength(2);
    });
  }}
/>

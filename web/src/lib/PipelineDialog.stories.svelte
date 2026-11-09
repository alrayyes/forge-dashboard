<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, userEvent, waitFor } from "storybook/test";
  import { mockFeed, type FeedAnswer } from "../../.storybook/mock-feed";
  import type { Check } from "./pipeline-checks.js";
  import type { PipelineTarget } from "./PipelineDialog.svelte";
  import PipelineDialog from "./PipelineDialog.svelte";

  const { Story } = defineMeta({
    title: "PipelineDialog",
    component: PipelineDialog,
    parameters: { layout: "fullscreen" },
  });

  const RUN = "https://github.com/alrayyes/forge-dashboard/actions/runs/9917";
  const minutesAgo = (n: number) =>
    new Date(Date.now() - n * 60_000).toISOString();

  const check = (over: Partial<Check> & Pick<Check, "name">): Check => ({
    status: "completed",
    conclusion: "success",
    url: `${RUN}/job/4800`,
    startedAt: minutesAgo(6),
    completedAt: minutesAgo(3),
    runId: 9917,
    runName: "ci",
    runNumber: 412,
    ...over,
  });

  const PASSING: Check[] = [
    check({ name: "lint", required: true, jobId: 4801 }),
    check({ name: "test / go", required: true, jobId: 4802 }),
    check({ name: "test / web", required: true, jobId: 4803 }),
    check({ name: "build image", required: false, jobId: 4804 }),
  ];

  const FAILING: Check[] = [
    check({
      name: "test / go",
      conclusion: "failure",
      required: true,
      jobId: 4802,
      failedStep: "Run go test ./...",
      excerpt:
        "--- FAIL: TestStatic_ServerWiring (0.02s)\n    static_test.go:48: GET /style.css: status 404, want 200\nFAIL",
    }),
    check({ name: "lint", required: true, jobId: 4801 }),
    check({ name: "build image", required: false, jobId: 4804 }),
  ];

  const RUNNING: Check[] = [
    check({
      name: "test / go",
      status: "in_progress",
      conclusion: undefined,
      completedAt: undefined,
      required: true,
      jobId: 4802,
    }),
    check({
      name: "test / web",
      status: "queued",
      conclusion: undefined,
      startedAt: undefined,
      completedAt: undefined,
      required: true,
      jobId: 4803,
    }),
    check({ name: "lint", required: true, jobId: 4801 }),
  ];

  const PULL_REQUEST: PipelineTarget = {
    subtitle: "alrayyes/forge-dashboard#3238",
    subject: {
      kind: "pull_request",
      forge: "github",
      fullName: "alrayyes/forge-dashboard",
      number: 3238,
    },
    repo: { forge: "github", fullName: "alrayyes/forge-dashboard" },
    emptyText: "This pull request has no checks.",
    errorText: "Couldn't load the checks",
    runUrl: RUN,
    forgeName: "GitHub",
  };

  const BRANCH: PipelineTarget = {
    ...PULL_REQUEST,
    subtitle: "alrayyes/forge-dashboard · main",
    subject: {
      kind: "main_branch",
      forge: "github",
      fullName: "alrayyes/forge-dashboard",
    },
    emptyText: "This branch has no checks.",
  };

  const opened = async (canvasElement: HTMLElement) => {
    await userEvent.click(
      canvasElement.querySelector("#open-pipeline") as HTMLElement,
    );
    await waitFor(() =>
      expect(document.querySelector("dialog[open]")).not.toBeNull(),
    );
  };

  const listed = async (canvasElement: HTMLElement) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".pipeline-check")).not.toBeNull(),
    );
  };

  const answer = (reply: FeedAnswer, runs?: Record<string, unknown>[]) => () =>
    reply && "checks" in reply ? { ...reply, runs } : reply;
</script>

<script lang="ts">
  let dialog = $state<PipelineDialog>();
</script>

{#snippet opener(target: PipelineTarget)}
  <!-- The pill on a board row; focus returns to it when the dialog closes. -->
  <button
    type="button"
    id="open-pipeline"
    onclick={(e) => dialog?.open({ ...target, opener: e.currentTarget })}
    >Show checks</button
  >
  <PipelineDialog bind:this={dialog} />
{/snippet}

<!-- The dialog is closed: only the pill that opens it is on the page. -->
<Story asChild name="Closed">{@render opener(PULL_REQUEST)}</Story>

<!-- The server has not sent the list yet. -->
<Story
  asChild
  name="Loading"
  beforeEach={() => mockFeed(() => null)}
  play={async ({ canvasElement }) => opened(canvasElement)}
>
  {@render opener(PULL_REQUEST)}
</Story>

<!-- Every check passed; required ones come under Required. -->
<Story
  asChild
  name="All passing"
  beforeEach={() => mockFeed(answer({ checks: PASSING }))}
  play={async ({ canvasElement }) => listed(canvasElement)}
>
  {@render opener(PULL_REQUEST)}
</Story>

<!-- A failed check is listed first, with its step and log excerpt. -->
<Story
  asChild
  name="Failed check"
  beforeEach={() => mockFeed(answer({ checks: FAILING }))}
  play={async ({ canvasElement }) => listed(canvasElement)}
>
  {@render opener(PULL_REQUEST)}
</Story>

<!-- Jobs still queued or running, with Cancel run for the run. -->
<Story
  asChild
  name="Running"
  beforeEach={() =>
    mockFeed(
      answer({ checks: RUNNING }, [{ runId: 9917, status: "in_progress" }]),
    )}
  play={async ({ canvasElement }) => listed(canvasElement)}
>
  {@render opener({
    ...PULL_REQUEST,
    cancel: {
      forge: "github",
      fullName: "alrayyes/forge-dashboard",
      allowed: () => true,
    },
  })}
</Story>

<!-- A branch on the Main branches page: no pull request number. -->
<Story
  asChild
  name="Main branch"
  beforeEach={() => mockFeed(answer({ checks: PASSING }))}
  play={async ({ canvasElement }) => listed(canvasElement)}
>
  {@render opener(BRANCH)}
</Story>

<!-- The forge listed no checks. -->
<Story
  asChild
  name="No checks"
  beforeEach={() => mockFeed(answer({ checks: [] }))}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".pipeline-status")?.textContent).toContain(
        "no checks",
      ),
    );
  }}
>
  {@render opener(PULL_REQUEST)}
</Story>

<!-- The server could not read the checks: an alert and Try again. -->
<Story
  asChild
  name="Error"
  beforeEach={() => mockFeed(() => ({ error: "GitHub did not answer" }))}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".pipeline-error")).not.toBeNull(),
    );
  }}
>
  {@render opener(PULL_REQUEST)}
</Story>

<!-- Keyboard focus on the close button after the dialog opens. -->
<Story
  asChild
  name="Focus on close"
  beforeEach={() => mockFeed(answer({ checks: PASSING }))}
  play={async ({ canvasElement }) => {
    await listed(canvasElement);
    await userEvent.tab();
  }}
>
  {@render opener(PULL_REQUEST)}
</Story>

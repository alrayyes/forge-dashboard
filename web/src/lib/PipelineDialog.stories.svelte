<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, userEvent, waitFor, within } from "storybook/test";
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

  // The words a link that leaves the dashboard carries: visible text, then the
  // new-tab warning, then the check, so the name still holds what is on screen.
  const linkName = (text: string, check: string) =>
    `${text} (opens in a new tab): ${check}`;

  const dialogEl = () => document.querySelector("dialog[open]") as HTMLElement;

  // The forge link a row draws in place of Show output: its name, where it
  // goes, the new-tab mark and the one decorative icon.
  const expectForgeLink = async (
    text: string,
    check: string,
    href: string,
  ): Promise<void> => {
    const link = within(dialogEl()).getByRole("link", {
      name: linkName(text, check),
    });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener");
    await expect(link.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(
      1,
    );
  };

  const FORGEJO: PipelineTarget = {
    ...PULL_REQUEST,
    repo: { forge: "forgejo", fullName: "alrayyes/forge-dashboard" },
    forgeName: "Forgejo",
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
  >
    Show checks
  </button>
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

<!-- Two workflows on a branch, one still going: the footer opens that one, not
     the newer finished run or the board's own address (#5077). -->
<Story
  asChild
  name="Main branch with a run still going"
  beforeEach={() =>
    mockFeed(
      answer({
        checks: [
          check({
            name: "build",
            status: "in_progress",
            conclusion: undefined,
            completedAt: undefined,
            url: `${RUN}/job/1`,
          }),
          check({
            name: "lint",
            url: "https://github.com/alrayyes/forge-dashboard/actions/runs/9920/job/2",
          }),
        ],
      }),
    )}
  play={async ({ canvasElement }) => {
    await listed(canvasElement);
    const link = within(dialogEl()).getByRole("link", {
      name: "Open latest running run on GitHub (opens in a new tab)",
    });
    await expect(link).toHaveTextContent(/^Open latest running run on GitHub$/);
    await expect(link).toHaveAttribute("href", RUN);
  }}
>
  {@render opener({
    ...BRANCH,
    runUrl: "https://github.com/alrayyes/forge-dashboard/actions/runs/9920",
  })}
</Story>

<!-- A failed branch whose failure the list leaves out (an external status
     beside check runs): the footer keeps the board's address for it. -->
<Story
  asChild
  name="Main branch failed outside the listed runs"
  beforeEach={() =>
    mockFeed(
      answer({
        checks: [
          check({ name: "build", url: `${RUN}/job/1` }),
          check({
            name: "lint",
            url: "https://github.com/alrayyes/forge-dashboard/actions/runs/9920/job/2",
          }),
        ],
      }),
    )}
  play={async ({ canvasElement }) => {
    await listed(canvasElement);
    const link = within(dialogEl()).getByRole("link", {
      name: "Open run on GitHub (opens in a new tab)",
    });
    await expect(link).toHaveAttribute(
      "href",
      "https://ci.example.com/build/1",
    );
  }}
>
  {@render opener({
    ...BRANCH,
    runUrl: "https://ci.example.com/build/1",
    failureUrl: () => "https://ci.example.com/build/1",
  })}
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

<!-- A forge id named like an inherited key, on a board that gave no forge
     name: the run link names the id, not a function (#4193). -->
<Story
  asChild
  name="Forge named constructor"
  beforeEach={() => mockFeed(answer({ checks: PASSING }))}
  play={async ({ canvasElement }) => {
    await listed(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".pipeline-run-button")?.textContent).toBe(
        "Open run on constructor",
      ),
    );
  }}
>
  {@render opener({
    ...PULL_REQUEST,
    repo: { forge: "constructor", fullName: "alrayyes/forge-dashboard" },
    forgeName: undefined,
  })}
</Story>

<!-- GitHub serves a job's log only once it has finished, so a queued or running
     job has no Show output, only the link to the forge, and a finished one
     has it. -->
<Story
  asChild
  name="GitHub queued and running"
  beforeEach={() =>
    mockFeed(
      answer({
        checks: [
          check({
            name: "queued-job",
            status: "queued",
            conclusion: undefined,
            startedAt: undefined,
            completedAt: undefined,
            url: RUN,
            jobId: 7,
          }),
          check({
            name: "running-job",
            status: "in_progress",
            conclusion: undefined,
            completedAt: undefined,
            url: `${RUN}2`,
            jobId: 8,
          }),
          check({ name: "done-job", url: `${RUN}3`, jobId: 9 }),
        ],
      }),
    )}
  play={async ({ canvasElement }) => {
    await listed(canvasElement);
    const dialog = within(dialogEl());
    await expect(
      dialog.getByRole("button", { name: "Show output: done-job" }),
    ).toBeVisible();
    for (const name of ["queued-job", "running-job"]) {
      await expect(
        dialog.queryByRole("button", { name: `Show output: ${name}` }),
      ).toBeNull();
    }
    await expectForgeLink("Open on GitHub", "queued-job", RUN);
    await expectForgeLink("Watch on GitHub", "running-job", `${RUN}2`);
  }}
>
  {@render opener(PULL_REQUEST)}
</Story>

<!-- Forgejo streams a running job's log, so it keeps Show output. -->
<Story
  asChild
  name="Forgejo running"
  beforeEach={() =>
    mockFeed(
      answer({
        checks: [
          check({
            name: "running-job",
            status: "in_progress",
            conclusion: undefined,
            completedAt: undefined,
            url: RUN,
            jobId: 8,
          }),
        ],
      }),
    )}
  play={async ({ canvasElement }) => {
    await listed(canvasElement);
    await expect(
      within(dialogEl()).getByRole("button", {
        name: "Show output: running-job",
      }),
    ).toBeVisible();
  }}
>
  {@render opener(FORGEJO)}
</Story>

<!-- A queued Forgejo job links to Forgejo, not GitHub. -->
<Story
  asChild
  name="Forgejo queued"
  beforeEach={() =>
    mockFeed(
      answer({
        checks: [
          check({
            name: "queued-job",
            status: "queued",
            conclusion: undefined,
            startedAt: undefined,
            completedAt: undefined,
            url: RUN,
            jobId: 7,
          }),
        ],
      }),
    )}
  play={async ({ canvasElement }) => {
    await listed(canvasElement);
    await expectForgeLink("Open on Forgejo", "queued-job", RUN);
    await expect(
      within(dialogEl()).queryByRole("link", {
        name: /Open on GitHub/,
      }),
    ).toBeNull();
  }}
>
  {@render opener(FORGEJO)}
</Story>

<!-- Every link that leaves the dashboard says what it opens, opens a new tab
     and shows one external-link icon: a queued job, a finished job's own
     link (beside its output), a check with no job id, and the run in the footer. -->
<Story
  asChild
  name="Links that leave the dashboard"
  beforeEach={() =>
    mockFeed(
      answer({
        checks: [
          check({
            name: "queued-job",
            status: "queued",
            conclusion: undefined,
            startedAt: undefined,
            completedAt: undefined,
            url: RUN,
            jobId: 7,
          }),
          check({
            name: "done-job",
            conclusion: "failure",
            url: RUN,
            jobId: 9,
          }),
          check({
            name: "lint",
            url: "https://ci.example.com/lint/1",
          }),
        ],
      }),
    )}
  play={async ({ canvasElement }) => {
    await listed(canvasElement);
    const dialog = within(dialogEl());
    const names = [
      linkName("Open on GitHub", "queued-job"),
      linkName("Open job on GitHub", "done-job"),
      linkName("Open check page", "lint"),
      "Open run on GitHub (opens in a new tab)",
    ];
    for (const name of names) {
      const link = dialog.getByRole("link", { name });
      await expect(link).toBeVisible();
      await expect(
        link.querySelectorAll('svg[aria-hidden="true"]'),
      ).toHaveLength(1);
    }
    await expect(
      dialogEl().querySelectorAll('a[target="_blank"]'),
    ).toHaveLength(names.length);
    await expect(
      dialogEl().querySelector(".pipeline-dialog-footer a"),
    ).toHaveTextContent(/^Open run on GitHub$/);
  }}
>
  {@render opener(PULL_REQUEST)}
</Story>

<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, userEvent, waitFor } from "storybook/test";
  import { mockFetch } from "../../.storybook/mock-fetch";
  import CheckRunOutput from "./CheckRunOutput.svelte";

  const { Story } = defineMeta({
    title: "CheckRunOutput",
    component: CheckRunOutput,
    args: {
      name: "test / go",
      jobId: 4821,
      repo: { forge: "github", fullName: "alrayyes/forge-dashboard" },
      runUrl: "https://github.com/alrayyes/forge-dashboard/actions/runs/9917",
      forgeName: "GitHub",
    },
  });

  const LOG = [
    "=== RUN   TestStatic_ServerWiring",
    "--- FAIL: TestStatic_ServerWiring (0.02s)",
    "    static_test.go:48: GET /style.css: status 404, want 200",
    "FAIL",
    "FAIL\tgithub.com/alrayyes/forge-dashboard/internal/api\t0.118s",
  ].join("\n");

  const view = async (canvasElement: HTMLElement) => {
    await userEvent.click(
      canvasElement.querySelector("button") as HTMLButtonElement,
    );
  };
</script>

<!-- Closed: Show output and the link to the forge. -->
<Story name="Closed" />

<!-- The output is being read. -->
<Story
  name="Loading"
  beforeEach={() =>
    mockFetch([{ match: /\/api\/v1\/checks\/log/, hang: true }])}
  play={async ({ canvasElement }) => view(canvasElement)}
/>

<!-- The output of a failed job. -->
<Story
  name="Output shown"
  beforeEach={() =>
    mockFetch([
      {
        match: /\/api\/v1\/checks\/log/,
        body: { text: LOG, truncated: false },
      },
    ])}
  play={async ({ canvasElement }) => {
    await view(canvasElement);
    await waitFor(() =>
      expect(canvasElement.querySelector("pre")).not.toBeNull(),
    );
  }}
/>

<!-- A long log is cut at the start, and the panel says so. -->
<Story
  name="Output cut"
  beforeEach={() =>
    mockFetch([
      { match: /\/api\/v1\/checks\/log/, body: { text: LOG, truncated: true } },
    ])}
  play={async ({ canvasElement }) => {
    await view(canvasElement);
    await waitFor(() =>
      expect(canvasElement.querySelector("pre")).not.toBeNull(),
    );
  }}
/>

<!-- The job wrote nothing. -->
<Story
  name="No output"
  beforeEach={() =>
    mockFetch([
      { match: /\/api\/v1\/checks\/log/, body: { text: "", truncated: false } },
    ])}
  play={async ({ canvasElement }) => {
    await view(canvasElement);
    await waitFor(() =>
      expect(canvasElement.querySelector("pre")).not.toBeNull(),
    );
  }}
/>

<!-- The saved token cannot read the job's output. -->
<Story
  name="Forbidden"
  beforeEach={() =>
    mockFetch([{ match: /\/api\/v1\/checks\/log/, status: 403 }])}
  play={async ({ canvasElement }) => {
    await view(canvasElement);
    await waitFor(() =>
      expect(canvasElement.querySelector(".run-output-error")).not.toBeNull(),
    );
  }}
/>

<!-- The forge has no output for the job any more. -->
<Story
  name="Expired"
  beforeEach={() =>
    mockFetch([{ match: /\/api\/v1\/checks\/log/, status: 404 }])}
  play={async ({ canvasElement }) => {
    await view(canvasElement);
    await waitFor(() =>
      expect(canvasElement.querySelector(".run-output-error")).not.toBeNull(),
    );
  }}
/>

<!-- No repository is named, so Show output is disabled; the forge link stays. -->
<Story name="Show output disabled" args={{ repo: undefined }} />

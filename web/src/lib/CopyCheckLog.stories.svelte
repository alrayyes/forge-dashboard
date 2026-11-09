<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, userEvent } from "storybook/test";
  import { mockFetch } from "../../.storybook/mock-fetch";
  import CopyCheckLog from "./CopyCheckLog.svelte";

  const { Story } = defineMeta({
    title: "CopyCheckLog",
    component: CopyCheckLog,
    args: {
      name: "test / go",
      jobId: 4821,
      repo: { forge: "github", fullName: "alrayyes/forge-dashboard" },
      forgeName: "GitHub",
      runKey: "run-9917",
      copyable: true,
      excerpt: [
        "--- FAIL: TestStatic_ServerWiring (0.02s)",
        "    static_test.go:48: GET /style.css: status 404, want 200",
        "FAIL",
        "FAIL\tgithub.com/alrayyes/forge-dashboard/internal/api\t0.118s",
      ].join("\n"),
    },
  });

  const LOG = (extra = "") =>
    `=== RUN   TestStatic_ServerWiring\n--- FAIL: TestStatic_ServerWiring (0.02s)\n    static_test.go:48: GET /style.css: status 404, want 200\nFAIL${extra}\n`;
</script>

<!-- A failed check: the excerpt and the Copy output button. -->
<Story name="Failed check" />

<!-- The button is pressed while the whole log is still being read. -->
<Story
  name="Copying"
  beforeEach={() =>
    mockFetch([{ match: /\/api\/v1\/checks\/log/, hang: true }])}
  play={async ({ canvasElement }) => {
    const button = canvasElement.querySelector("button") as HTMLButtonElement;
    await userEvent.click(button);
    await expect(button.getAttribute("aria-busy")).toBe("true");
  }}
/>

<!-- The whole log could not be read, so the excerpt is what is copied. -->
<Story
  name="Log unreadable"
  beforeEach={() =>
    mockFetch([
      { match: /\/api\/v1\/checks\/log/, status: 404, body: { error: "gone" } },
    ])}
  play={async ({ canvasElement }) => {
    await userEvent.click(
      canvasElement.querySelector("button") as HTMLButtonElement,
    );
  }}
/>

<!-- Pressed with a readable log: the status line says which landed. -->
<Story
  name="Copied"
  beforeEach={() =>
    mockFetch([
      {
        match: /\/api\/v1\/checks\/log/,
        body: { text: LOG(), truncated: false },
      },
    ])}
  play={async ({ canvasElement }) => {
    await userEvent.click(
      canvasElement.querySelector("button") as HTMLButtonElement,
    );
  }}
/>

<!-- A check with no job id (a status, not a run) copies its excerpt. -->
<Story name="No job" args={{ jobId: undefined }} />

<!-- Nothing to copy: the excerpt only, no button. -->
<Story name="Not copyable" args={{ copyable: false }} />

<!-- Nothing at all: no excerpt and no button. -->
<Story name="Empty" args={{ copyable: false, excerpt: "" }} />

<!-- Keyboard focus on the button. -->
<Story
  name="Focused"
  play={async ({ canvasElement }) => {
    await userEvent.tab();
    await userEvent.tab();
    await expect(document.activeElement).toBe(
      canvasElement.querySelector("button"),
    );
  }}
/>

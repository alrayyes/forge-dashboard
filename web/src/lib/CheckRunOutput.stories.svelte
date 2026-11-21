<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, userEvent, waitFor, within } from "storybook/test";
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

  const RUN = "https://github.com/alrayyes/forge-dashboard/actions/runs/9917";

  // The link to the job on the forge, as the page draws it beside a note or an
  // error: its words, its name, where it goes and the new-tab mark.
  const expectJobLink = async (
    holder: HTMLElement,
    text: string,
  ): Promise<void> => {
    const link = within(holder).getByRole("link", {
      name: `${text} (opens in a new tab): test / go`,
    });
    await expect(link).toHaveTextContent(text);
    await expect(link).toHaveAttribute("href", RUN);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener");
    await expect(link.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(
      1,
    );
  };

  const errorOf = async (canvasElement: HTMLElement): Promise<HTMLElement> => {
    await view(canvasElement);
    await waitFor(() =>
      expect(canvasElement.querySelector(".run-output-error")).not.toBeNull(),
    );
    return canvasElement.querySelector(".run-output-error") as HTMLElement;
  };
  // Stands in for the browser's clipboard for one story: `write` reads the item
  // it is given, and the selection copy is refused or allowed as asked.
  // The returned function puts the real ones back.
  const fakeClipboard = (opts: {
    clipboard: boolean;
    selection: boolean;
  }): (() => void) => {
    const realExec = document.execCommand;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: opts.clipboard
        ? {
            // Like the real one, a write fails when its item's text does.
            write: async (items: ClipboardItem[]) => {
              for (const item of items) {
                await (await item.getType("text/plain")).text();
              }
            },
            writeText: async () => {},
          }
        : undefined,
    });
    document.execCommand = () => opts.selection;
    return () => {
      Reflect.deleteProperty(navigator, "clipboard");
      document.execCommand = realExec;
    };
  };

  const copyButton = (canvasElement: HTMLElement): HTMLElement =>
    within(canvasElement).getByRole("button", {
      name: "Copy output: test / go",
    });

  const statusOf = (canvasElement: HTMLElement): HTMLElement =>
    canvasElement.querySelector(".run-output-status") as HTMLElement;
</script>

<!-- Closed: Show output and the link to the forge. -->
<Story
  name="Closed"
  play={async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole("button", {
      name: "Show output: test / go",
    });
    await expect(toggle).toHaveTextContent("Show output");
    await expect(toggle).not.toHaveTextContent("Show full output");
  }}
/>

<!-- Closed beside a failure excerpt the row already shows: the press opens the
     full output, so the toggle says so (#4236). The visible words stay inside
     the accessible name, and the width is the one Show output has. -->
<Story
  name="Closed with an excerpt"
  args={{ excerptVisible: true }}
  play={async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole("button", {
      name: "Show full output: test / go",
    });
    await expect(toggle).toHaveTextContent(/^Full output$/);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle.getBoundingClientRect().height).toBeGreaterThanOrEqual(
      24,
    );
  }}
/>

<!-- Opening it with an excerpt in view reads Hide output, as without one. -->
<Story
  name="Open with an excerpt"
  args={{ excerptVisible: true }}
  beforeEach={() =>
    mockFetch([
      {
        match: /\/api\/v1\/checks\/log/,
        body: { text: LOG, truncated: false },
      },
    ])}
  play={async ({ canvasElement }) => {
    await view(canvasElement);
    const toggle = within(canvasElement).getByRole("button", {
      name: "Hide output: test / go",
    });
    await expect(toggle).toHaveTextContent("Hide output");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }}
/>

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
    const note = canvasElement.querySelector(".run-output-note") as HTMLElement;
    await expect(note).toHaveTextContent(
      "Showing the last 256 KB of this output.",
    );
    await expectJobLink(note, "Open job on GitHub for the rest");
    // A note is small and keeps the ordinary ink; only an error is red.
    await expect(getComputedStyle(note).fontSize).toBe("12px");
    await expect(getComputedStyle(note).color).not.toBe("rgb(197, 47, 55)");
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
    mockFetch([
      {
        match: /\/api\/v1\/checks\/log/,
        status: 403,
        body: { error: "Resource not accessible" },
      },
    ])}
  play={async ({ canvasElement }) => {
    const error = await errorOf(canvasElement);
    await expect(error).toHaveTextContent(
      "The saved GitHub token can't read this output.",
    );
    await expectJobLink(error, "Open job on GitHub");
    // A plain sentence, never the forge's own words.
    await expect(canvasElement).not.toHaveTextContent(
      "Resource not accessible",
    );
    // An error is red and as small as a note.
    await expect(getComputedStyle(error).fontSize).toBe("12px");
    // The red is the danger ink of whichever theme the page is in.
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    await expect(getComputedStyle(error).color).toBe(
      dark ? "rgb(255, 115, 118)" : "rgb(197, 47, 55)",
    );
  }}
/>

<!-- The forge has no output for the job any more. -->
<Story
  name="Expired"
  beforeEach={() =>
    mockFetch([
      {
        match: /\/api\/v1\/checks\/log/,
        status: 404,
        body: { error: "gone" },
      },
    ])}
  play={async ({ canvasElement }) => {
    const error = await errorOf(canvasElement);
    await expect(error).toHaveTextContent(
      "GitHub has no output for this check. It may have expired.",
    );
    await expectJobLink(error, "Open job on GitHub");
  }}
/>

<!-- The forge is limiting requests: the sentence stays and there is no job
     link, since the job is fine and waiting is the answer. -->
<Story
  name="Rate limited"
  beforeEach={() =>
    mockFetch([{ match: /\/api\/v1\/checks\/log/, status: 429, body: {} }])}
  play={async ({ canvasElement }) => {
    const error = await errorOf(canvasElement);
    await expect(error).toHaveTextContent("is limiting requests right now");
    await expect(within(error).queryByRole("link")).toBeNull();
  }}
/>

<!-- Copy on a cut log says which part it copied, and where the rest is. -->
<Story
  name="Copy a cut output"
  beforeEach={() => {
    const restore = fakeClipboard({ clipboard: true, selection: true });
    const undo = mockFetch([
      {
        match: /\/api\/v1\/checks\/log/,
        body: { text: "tail\n", truncated: true },
      },
    ]);
    return () => {
      restore();
      return undo?.();
    };
  }}
  play={async ({ canvasElement }) => {
    await view(canvasElement);
    await waitFor(() =>
      expect(canvasElement.querySelector("pre")).not.toBeNull(),
    );
    await userEvent.click(copyButton(canvasElement));
    await waitFor(() =>
      expect(statusOf(canvasElement)).toHaveTextContent(
        "Copied the last 256 KB of the output, which is all the dashboard keeps. Open the job on GitHub for the rest.",
      ),
    );
  }}
/>

<!-- Copy on an output the job never wrote says nothing was copied. -->
<Story
  name="Copy no output"
  beforeEach={() => {
    const restore = fakeClipboard({ clipboard: true, selection: true });
    const undo = mockFetch([
      { match: /\/api\/v1\/checks\/log/, body: { text: "", truncated: false } },
    ]);
    return () => {
      restore();
      return undo?.();
    };
  }}
  play={async ({ canvasElement }) => {
    await view(canvasElement);
    await waitFor(() =>
      expect(canvasElement.querySelector("pre")).not.toBeNull(),
    );
    await userEvent.click(copyButton(canvasElement));
    await waitFor(() =>
      expect(statusOf(canvasElement)).toHaveTextContent("Nothing was copied."),
    );
  }}
/>

<!-- When the browser refuses every way to copy, the output goes into a field
     to copy by hand: it holds the text, has focus, and the line says how. -->
<Story
  name="Copy refused"
  beforeEach={() => {
    const restore = fakeClipboard({ clipboard: false, selection: false });
    const undo = mockFetch([
      {
        match: /\/api\/v1\/checks\/log/,
        body: { text: "step 1\nboom: exit 1\n", truncated: false },
      },
    ]);
    return () => {
      restore();
      return undo?.();
    };
  }}
  play={async ({ canvasElement }) => {
    await view(canvasElement);
    await waitFor(() =>
      expect(canvasElement.querySelector("pre")).not.toBeNull(),
    );
    await userEvent.click(copyButton(canvasElement));
    const field = await within(canvasElement).findByRole("textbox", {
      name: "Output to copy: test / go",
    });
    await expect(field).toHaveValue("step 1\nboom: exit 1\n");
    await expect(field).toHaveFocus();
    await expect(statusOf(canvasElement)).toHaveTextContent("Cmd+C");
  }}
/>

<!-- The output opens from the keyboard, can take focus to scroll, and hides
     again, which removes it. -->
<Story
  name="By keyboard"
  beforeEach={() =>
    mockFetch([
      {
        match: /\/api\/v1\/checks\/log/,
        body: { text: "line\n", truncated: false },
      },
    ])}
  play={async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("button", { name: "Show output: test / go" }).focus();
    await userEvent.keyboard("{Enter}");
    const output = await canvas.findByRole("region", {
      name: "Output: test / go",
    });
    await expect(output).toBeVisible();
    output.focus();
    await expect(output).toHaveFocus();
    await userEvent.click(
      canvas.getByRole("button", { name: "Hide output: test / go" }),
    );
    await expect(canvas.queryByRole("region")).toBeNull();
  }}
/>

<!-- No repository is named, so Show output is disabled; the forge link stays. -->
<Story name="Show output disabled" args={{ repo: undefined }} />

<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, userEvent, waitFor } from "storybook/test";
  import { copyButton } from "./copy-details.js";
  import type { FailureDetails } from "./feedback.js";

  const { Story } = defineMeta({
    title: "CopyDetails",
  });

  // What the server refused with: the same body the e2e journeys serve.
  const DETAILS: FailureDetails = {
    status: 403,
    response: {
      error:
        "forgejo: POST /repos/alrayyes/obsidian/issues/244/labels: 403 raw refusal text from the forge",
      code: "unknown",
    },
    action: "renovate",
    forge: "forgejo",
    repo: "alrayyes/obsidian",
    number: 244,
    at: "2026-11-17T12:00:00.000Z",
  };
  const TEXT = JSON.stringify(DETAILS, null, 2);

  type Host = "row" | "toast" | "pipeline";

  // The three places the button lives, with the class names the page gives
  // them (feedback-ui.ts, Dashboard.svelte, branch-rerun.ts).
  const CLASSES: Record<Host, [string, string]> = {
    row: ["row-feedback-line", "row-action row-feedback-copy"],
    toast: ["feedback-toast", "feedback-link"],
    pipeline: ["pipeline-rerun-failure", "row-action pipeline-rerun-copy"],
  };

  // Puts the real button where the page puts it.
  function place(node: HTMLElement, host: Host) {
    node.append(copyButton(DETAILS, CLASSES[host][1]));
  }

  // Swaps the browser's clipboard for the test's, put back when the story ends.
  function clipboard(writeText: ((text: string) => Promise<void>) | null) {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: writeText ? { writeText } : undefined,
      configurable: true,
    });
    return () => {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as unknown as Record<string, unknown>).clipboard;
    };
  }

  const button = (el: HTMLElement) =>
    el.querySelector("button") as HTMLButtonElement;
  const box = (el: HTMLElement) =>
    el.querySelector("textarea.feedback-details") as HTMLTextAreaElement | null;

  // The button's two-second timer is held back, so a story fires it itself.
  // Only that delay: waitFor needs the rest.
  const held: { fn: () => void; ms: number }[] = [];
  function holdTimer(restoreClipboard: () => void) {
    held.length = 0;
    const real = window.setTimeout;
    window.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 2000) {
        held.push({ fn, ms });
        return 0;
      }
      return real(fn, ms, ...rest);
    }) as unknown as typeof window.setTimeout;
    return () => {
      window.setTimeout = real;
      restoreClipboard();
    };
  }

  // `writeText` calls land here.
  const written: string[] = [];
  const accept = clipboard.bind(null, async (text: string) => {
    written.push(text);
  });
  const refuse = clipboard.bind(null, () =>
    Promise.reject(new Error("NotAllowedError")),
  );
</script>

{#snippet row()}
  <div id="host">
    <div class="row-feedback-line" data-phase="failed" use:place={"row"}>
      <span>The forge refused this action and gave no reason.</span>
    </div>
  </div>
{/snippet}

{#snippet toast()}
  <div id="host">
    <div class="feedback-toast" use:place={"toast"}>
      <span>The forge refused this action and gave no reason.</span>
    </div>
  </div>
{/snippet}

{#snippet pipeline()}
  <div id="host">
    <div class="pipeline-rerun-failure" use:place={"pipeline"}>
      <span>The forge refused this action and gave no reason.</span>
    </div>
  </div>
{/snippet}

<!-- A failed row: a Copy button beside the sentence, named for assistive tech. -->
<Story
  name="Row, before pressing"
  template={row}
  play={async ({ canvasElement }) => {
    const copy = button(canvasElement);
    await expect(copy.textContent).toBe("Copy");
    await expect(copy.getAttribute("aria-label")).toBe("Copy error details");
    await expect(copy.type).toBe("button");
    await expect(copy.className).toBe("row-action row-feedback-copy");
    await expect(box(canvasElement)).toBeNull();
  }}
/>

<!-- Pressed with a clipboard: it holds the details as JSON, and the button says Copied, then Copy again after two seconds. -->
<Story
  name="Copied"
  template={row}
  beforeEach={() => {
    written.length = 0;
    return holdTimer(accept());
  }}
  play={async ({ canvasElement }) => {
    const copy = button(canvasElement);
    await userEvent.click(copy);
    await waitFor(() => expect(copy.textContent).toBe("Copied"));
    await expect(written).toEqual([TEXT]);
    await expect(box(canvasElement)).toBeNull();

    await expect(held.map((t) => t.ms)).toEqual([2000]);
    held[0].fn();
    await expect(copy.textContent).toBe("Copy");
  }}
/>

<!-- The clipboard refuses: the details show in a read-only box after the line, selected and focused, instead of failing silently. -->
<Story
  name="Row, clipboard refused"
  template={row}
  beforeEach={refuse}
  play={async ({ canvasElement }) => {
    await userEvent.click(button(canvasElement));
    await waitFor(() => expect(box(canvasElement)).not.toBeNull());
    const area = box(canvasElement) as HTMLTextAreaElement;
    await expect(area.getAttribute("aria-label")).toBe("Error details");
    await expect(area.readOnly).toBe(true);
    await expect(area.rows).toBe(8);
    await expect(area.value).toBe(TEXT);
    await expect(document.activeElement).toBe(area);
    await expect(area.selectionStart).toBe(0);
    await expect(area.selectionEnd).toBe(TEXT.length);
    // On a row the box follows the line, not inside it.
    const line = canvasElement.querySelector(".row-feedback-line");
    await expect(line?.nextElementSibling).toBe(area);
    await expect(button(canvasElement).textContent).toBe("Copy");
    // Pressing again reuses the box.
    await userEvent.click(button(canvasElement));
    await expect(canvasElement.querySelectorAll("textarea").length).toBe(1);
  }}
/>

<!-- No clipboard at all (an insecure context): the same box. -->
<Story
  name="Row, no clipboard"
  template={row}
  beforeEach={() => clipboard(null)}
  play={async ({ canvasElement }) => {
    await userEvent.click(button(canvasElement));
    const area = box(canvasElement) as HTMLTextAreaElement;
    await expect(area.value).toBe(TEXT);
    await expect(area.readOnly).toBe(true);
  }}
/>

<!-- On a toast the box goes inside it. -->
<Story
  name="Toast, clipboard refused"
  template={toast}
  beforeEach={refuse}
  play={async ({ canvasElement }) => {
    await userEvent.click(button(canvasElement));
    await waitFor(() => expect(box(canvasElement)).not.toBeNull());
    const area = box(canvasElement) as HTMLTextAreaElement;
    await expect(area.parentElement?.className).toBe("feedback-toast");
    await expect(area.value).toBe(TEXT);
  }}
/>

<!-- In the pipeline panel's rerun failure the box goes inside it too. -->
<Story
  name="Pipeline rerun, clipboard refused"
  template={pipeline}
  beforeEach={refuse}
  play={async ({ canvasElement }) => {
    await userEvent.click(button(canvasElement));
    await waitFor(() => expect(box(canvasElement)).not.toBeNull());
    const area = box(canvasElement) as HTMLTextAreaElement;
    await expect(area.parentElement?.className).toBe("pipeline-rerun-failure");
    await expect(area.getAttribute("aria-label")).toBe("Error details");
  }}
/>

<!-- Keyboard: the button takes focus and Enter copies. -->
<Story
  name="Keyboard"
  template={row}
  beforeEach={() => {
    written.length = 0;
    return holdTimer(accept());
  }}
  play={async ({ canvasElement }) => {
    const copy = button(canvasElement);
    await userEvent.tab();
    await expect(document.activeElement).toBe(copy);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(written).toEqual([TEXT]));
    // Back to Copy, so the saved screenshot's button name matches its text.
    await waitFor(() => expect(copy.textContent).toBe("Copied"));
    held[0].fn();
  }}
/>

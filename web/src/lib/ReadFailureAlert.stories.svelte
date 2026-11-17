<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, fn, userEvent, within } from "storybook/test";
  import {
    dashboardRead,
    setDashboardRereader,
  } from "./dashboard-read.svelte.js";
  import ReadFailureAlert from "./ReadFailureAlert.svelte";

  // The layout's re-read, which Retry asks for.
  const reread = fn();

  const { Story } = defineMeta({
    title: "ReadFailureAlert",
    component: ReadFailureAlert,
  });
</script>

<!-- The dashboard read failed: the banner names the problem and offers Retry,
     which asks the layout to read again. -->
<Story
  name="Error with retry"
  beforeEach={() => {
    reread.mockClear();
    setDashboardRereader(reread);
    dashboardRead.lastError = "Could not load the dashboard. Try again.";
    return () => {
      setDashboardRereader(null);
      dashboardRead.lastError = null;
    };
  }}
  play={async ({ canvasElement, step }) => {
    const alert = within(canvasElement).getByRole("alert");
    await expect(alert).toHaveTextContent(
      "Could not load the dashboard. Try again.",
    );
    const retry = within(alert).getByRole("button", { name: "Retry" });
    await step("Retry reads again", async () => {
      await userEvent.click(retry);
      await expect(reread).toHaveBeenCalledTimes(1);
    });
  }}
/>

<!-- Keyboard focus on Retry: a visible outline. The 44px phone target needs a
     390px viewport, so it stays in the e2e spec. -->
<Story
  name="Retry focused"
  beforeEach={() => {
    dashboardRead.lastError = "Could not load the dashboard. Try again.";
    return () => {
      dashboardRead.lastError = null;
    };
  }}
  play={async ({ canvasElement }) => {
    const retry = within(canvasElement).getByRole("button", { name: "Retry" });
    await userEvent.tab();
    await expect(retry).toHaveFocus();
    const style = getComputedStyle(retry);
    await expect(style.outlineStyle).not.toBe("none");
    await expect(parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
  }}
/>

<!-- A page with a read of its own passes the message and the retry (#3272). -->
<Story
  name="Page read error"
  args={{
    message: "The backend answered with an error (500).",
    onretry: () => {},
  }}
  play={async ({ canvasElement }) => {
    const alert = within(canvasElement).getByRole("alert");
    await expect(alert).toHaveTextContent(
      "The backend answered with an error (500).",
    );
    await expect(alert).not.toHaveTextContent("Could not reach");
  }}
/>

<!-- No error: the component renders nothing. -->
<Story
  name="Hidden"
  beforeEach={() => {
    dashboardRead.lastError = null;
  }}
  play={async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("alert")).toBeNull();
    await expect(canvasElement.querySelector("button")).toBeNull();
  }}
/>

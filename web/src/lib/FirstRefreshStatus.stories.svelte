<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, userEvent, waitFor } from "storybook/test";
  import { firstRefresh } from "./first-refresh.svelte.js";
  import FirstRefreshStatus from "./FirstRefreshStatus.svelte";

  const { Story } = defineMeta({
    title: "FirstRefreshStatus",
    component: FirstRefreshStatus,
  });

  const status = (canvasElement: HTMLElement) =>
    canvasElement.querySelector(
      '[data-testid="first-refresh-status"]',
    ) as HTMLElement;
</script>

<script lang="ts">
  let pending = $state(false);
</script>

<!-- The server has finished its first refresh: the line stays, with no text. -->
<Story
  name="Done"
  args={{ pending: false, subject: "issues" }}
  play={async ({ canvasElement }) => {
    const line = status(canvasElement);
    await expect(line.textContent?.trim()).toBe("");
    await expect(line.getAttribute("role")).toBe("status");
    await expect(line.getAttribute("aria-live")).toBe("polite");
  }}
/>

<!-- Just after page load. -->
<Story
  name="Loading"
  args={{ pending: true, subject: "issues" }}
  beforeEach={() => {
    firstRefresh.startedAt = Date.now();
  }}
  play={async ({ canvasElement }) => {
    await expect(status(canvasElement).textContent?.trim()).toBe(
      "Loading your issues…",
    );
  }}
/>

<!-- Past ten seconds the line admits it is slow. -->
<Story
  name="Still loading"
  args={{ pending: true, subject: "issues" }}
  beforeEach={() => {
    firstRefresh.startedAt = Date.now() - 30_000;
  }}
  play={async ({ canvasElement }) => {
    await expect(status(canvasElement).textContent?.trim()).toBe(
      "Still loading. The first refresh can take a while after a restart.",
    );
  }}
/>

<!-- The line is in the page before it has text, and the text arrives as a
     change to that same element, so a screen reader announces it. -->
<Story
  asChild
  name="Announces by changing text"
  beforeEach={() => {
    firstRefresh.startedAt = Date.now();
    pending = false;
  }}
  play={async ({ canvasElement }) => {
    const before = status(canvasElement);
    await expect(before.textContent?.trim()).toBe("");
    await userEvent.click(
      canvasElement.querySelector("#start-loading") as HTMLElement,
    );
    await waitFor(() =>
      expect(status(canvasElement).textContent?.trim()).toBe(
        "Loading your pull requests…",
      ),
    );
    await expect(status(canvasElement)).toBe(before);
  }}
>
  <button type="button" id="start-loading" onclick={() => (pending = true)}
    >Start loading</button
  >
  <FirstRefreshStatus {pending} subject="pull requests" />
</Story>

<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, userEvent } from "storybook/test";
  import Disclosure from "./Disclosure.svelte";

  const { Story } = defineMeta({
    title: "Disclosure",
    component: Disclosure,
  });
</script>

{#snippet help()}
  <p id="webhook-help-text">
    Add a webhook in the repository's settings that points at this dashboard and
    sends pull request and check run events.
  </p>
{/snippet}

<!-- Closed by default. -->
<Story
  name="Closed"
  args={{
    id: "webhook-help",
    label: "How do I add a webhook?",
    children: help,
  }}
/>

<!-- Open after a click. -->
<Story
  name="Open"
  args={{
    id: "webhook-help",
    label: "How do I add a webhook?",
    children: help,
  }}
  play={async ({ canvasElement }) => {
    const button = canvasElement.querySelector("button") as HTMLButtonElement;
    await userEvent.click(button);
    await expect(button.getAttribute("aria-expanded")).toBe("true");
  }}
/>

<!-- Keyboard focus on the toggle. -->
<Story
  name="Focused"
  args={{
    id: "webhook-help",
    label: "How do I add a webhook?",
    children: help,
  }}
  play={async ({ canvasElement }) => {
    const button = canvasElement.querySelector("button") as HTMLButtonElement;
    await userEvent.tab();
    await expect(document.activeElement).toBe(button);
  }}
/>

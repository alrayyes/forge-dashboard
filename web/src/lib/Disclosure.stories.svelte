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
  <p id="token-help-text">
    Read access to your repositories, their pull requests and their commit
    status.
  </p>
{/snippet}

<!-- Closed by default. -->
<Story
  name="Closed"
  args={{
    id: "token-help",
    label: "What does this token need?",
    children: help,
  }}
/>

<!-- Open after a click. -->
<Story
  name="Open"
  args={{
    id: "token-help",
    label: "What does this token need?",
    children: help,
  }}
  play={async ({ canvasElement }) => {
    const button = canvasElement.querySelector("button") as HTMLButtonElement;
    await userEvent.click(button);
    await expect(button.getAttribute("aria-expanded")).toBe("true");
  }}
/>

<!-- Open, with focus moved off the toggle: the panel without a focus ring. -->
<Story
  name="Open not focused"
  args={{
    id: "token-help",
    label: "What does this token need?",
    children: help,
  }}
  play={async ({ canvasElement }) => {
    const button = canvasElement.querySelector("button") as HTMLButtonElement;
    await userEvent.click(button);
    button.blur();
    await expect(button.getAttribute("aria-expanded")).toBe("true");
    await expect(document.activeElement).not.toBe(button);
  }}
/>

<!-- Keyboard focus on the toggle. -->
<Story
  name="Focused"
  args={{
    id: "token-help",
    label: "What does this token need?",
    children: help,
  }}
  play={async ({ canvasElement }) => {
    const button = canvasElement.querySelector("button") as HTMLButtonElement;
    await userEvent.tab();
    await expect(document.activeElement).toBe(button);
  }}
/>

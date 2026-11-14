<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect } from "storybook/test";
  import SettingsNav from "./SettingsNav.svelte";

  const { Story } = defineMeta({
    title: "SettingsNav",
    component: SettingsNav,
  });
</script>

<Story name="Display current" args={{ current: "display" }} />
<Story name="Connections current" args={{ current: "connections" }} />
<Story name="Behaviour current" args={{ current: "behaviour" }} />
<Story name="Integrations current" args={{ current: "integrations" }} />

<!-- Keyboard focus on a group that is not the current one. -->
<Story
  name="Focus on a group"
  args={{ current: "display" }}
  play={async ({ canvasElement }) => {
    const link = canvasElement.querySelectorAll("a")[2] as HTMLElement;
    link.focus();
    await expect(document.activeElement).toBe(link);
  }}
/>

<!-- Keyboard focus on the current group: the focus ring and the current-group bar together. -->
<Story
  name="Focus on the current group"
  args={{ current: "display" }}
  play={async ({ canvasElement }) => {
    const link = canvasElement.querySelector(
      'a[aria-current="page"]',
    ) as HTMLElement;
    link.focus();
    await expect(document.activeElement).toBe(link);
  }}
/>

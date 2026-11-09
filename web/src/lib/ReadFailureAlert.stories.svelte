<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { dashboardRead } from "./dashboard-read.svelte.js";
  import ReadFailureAlert from "./ReadFailureAlert.svelte";

  const { Story } = defineMeta({
    title: "ReadFailureAlert",
    component: ReadFailureAlert,
  });
</script>

<!-- The dashboard read failed: the banner names the problem and offers Retry. -->
<Story
  name="Error with retry"
  beforeEach={() => {
    dashboardRead.lastError = "Could not load the dashboard. Try again.";
    return () => {
      dashboardRead.lastError = null;
    };
  }}
/>

<!-- No error: the component renders nothing. -->
<Story
  name="Hidden"
  beforeEach={() => {
    dashboardRead.lastError = null;
  }}
/>

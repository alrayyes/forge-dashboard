<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { firstRefresh } from "./first-refresh.svelte.js";
  import FirstRefreshStatus from "./FirstRefreshStatus.svelte";

  const { Story } = defineMeta({
    title: "FirstRefreshStatus",
    component: FirstRefreshStatus,
  });
</script>

<!-- The server has finished its first refresh: the line stays, with no text. -->
<Story name="Done" args={{ pending: false, subject: "issues" }} />

<!-- Just after page load. -->
<Story
  name="Loading"
  args={{ pending: true, subject: "issues" }}
  beforeEach={() => {
    firstRefresh.startedAt = Date.now();
  }}
/>

<!-- Past ten seconds the line admits it is slow. -->
<Story
  name="Still loading"
  args={{ pending: true, subject: "issues" }}
  beforeEach={() => {
    firstRefresh.startedAt = Date.now() - 30_000;
  }}
/>

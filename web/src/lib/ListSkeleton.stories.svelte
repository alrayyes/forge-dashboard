<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ListSkeleton from "./ListSkeleton.svelte";

  const { Story } = defineMeta({
    title: "ListSkeleton",
    component: ListSkeleton,
  });
</script>

<!-- The first refresh has not finished: four placeholder rows. -->
<Story name="Default rows" />

<Story name="One row" args={{ rows: 1 }} />

<Story name="Long list" args={{ rows: 8 }} />

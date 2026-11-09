<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import type { NavCount } from "./nav-counts.svelte.js";
  import NavPills from "./NavPills.svelte";

  const { Story } = defineMeta({
    title: "NavPills",
    component: NavPills,
    // The pill is aria-hidden and always sits inside the nav link, whose own
    // text names it. The decorator-free story renders it on its own, so each
    // story below wraps it the way the layout does.
  });
</script>

{#snippet inLink(
  count: NavCount | null,
  extra: { stacked?: boolean; pending?: boolean } = {},
)}
  <nav aria-label="Pages">
    <a href="#pull-requests">Pull requests <NavPills {count} {...extra} /></a>
  </nav>
{/snippet}

<!-- Every outcome at once: total, failed, passed, then the running state. -->
<Story asChild name="All counts">
  {@render inLink({ total: 15, failed: 2, passed: 10, running: 3 })}
</Story>

<!-- Nothing failing: a zero is never drawn. -->
<Story asChild name="Passing only">
  {@render inLink({ total: 6, failed: 0, passed: 6, running: 0 })}
</Story>

<!-- Branches also counts the ones with no pipeline. -->
<Story asChild name="Branches with no pipeline">
  {@render inLink({ total: 9, failed: 1, passed: 6, running: 1, none: 1 })}
</Story>

<!-- Nothing in the page: no pill at all. -->
<Story asChild name="Empty">
  {@render inLink({ total: 0, failed: 0 })}
</Story>

<!-- The first refresh has not finished: a dash, never a 0. -->
<Story asChild name="First refresh pending">
  {@render inLink(null, { pending: true })}
</Story>

<!-- The phone layout stacks the counts under the total. -->
<Story asChild name="Stacked">
  {@render inLink(
    { total: 15, failed: 2, passed: 10, running: 3 },
    { stacked: true },
  )}
</Story>

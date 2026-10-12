<script lang="ts">
  import type { NavCount } from "#lib/nav-counts.svelte.js";

  // A neutral total, then a red failed count with a warning glyph, shown only
  // above zero. Red is never alone: the glyph says "failing" without colour,
  // and the link's own name says it in words, so the pills are aria-hidden.
  // Nothing at all for a page with nothing in it: a zero is never drawn.
  let {
    count,
    stacked = false,
  }: { count: NavCount | null; stacked?: boolean } = $props();
</script>

{#if count && count.total > 0}
  <span class="nav-pills" class:stacked aria-hidden="true">
    <span class="nav-total">{count.total}</span>
    {#if count.failed > 0}
      <span class="nav-failed"
        ><svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><circle cx="12" cy="12" r="10" /><line
            x1="12"
            x2="12"
            y1="8"
            y2="12"
          /><line x1="12" x2="12.01" y1="16" y2="16" /></svg
        >{count.failed}</span
      >
    {/if}
  </span>
{/if}

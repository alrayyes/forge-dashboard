<script lang="ts">
  import type { NavCount } from "#lib/nav-counts.svelte.js";

  // One pill (#1439): a neutral total, then the counts above zero in triage
  // order, failed, running, passed, each with its own glyph. Colour is never
  // alone: the glyph says the state without it, and the link's own name says
  // it in words, so the pill is aria-hidden. Nothing at all for a page with
  // nothing in it, and a zero is never drawn.
  let {
    count,
    stacked = false,
  }: { count: NavCount | null; stacked?: boolean } = $props();
</script>

{#if count && count.total > 0}
  <span class="nav-pills" class:stacked aria-hidden="true">
    <span class="nav-total">{count.total}</span>
    {#if count.failed > 0}
      <span class="nav-count nav-failed"
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
    {#if (count.running ?? 0) > 0}
      <!-- A spinner, and a still clock for prefers-reduced-motion: the
           stylesheet shows the one that fits. -->
      <span class="nav-count nav-running"
        ><svg
          class="glyph-spin"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56" /></svg
        ><svg
          class="glyph-clock"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><circle cx="12" cy="12" r="10" /><polyline
            points="12 6 12 12 16 14"
          /></svg
        >{count.running}</span
      >
    {/if}
    {#if (count.passed ?? 0) > 0}
      <span class="nav-count nav-passed"
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
          ><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></svg
        >{count.passed}</span
      >
    {/if}
  </span>
{/if}

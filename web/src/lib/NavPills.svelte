<script lang="ts">
  import type { NavCount } from "#lib/nav-counts.svelte.js";
  import { pillParts } from "#lib/nav-labels.js";

  // One pill (#1439, #1563): a neutral total, then the outcomes, failed and
  // passed, then a thin divider and the state, running, and for Branches the
  // ones without a pipeline (#1531), each with its own glyph. Colour is never
  // alone: the glyph says the state without it, and the link's own name says
  // it in words, so the pill is aria-hidden. Nothing at all for a page with
  // nothing in it, and a zero is never drawn.
  let {
    count,
    stacked = false,
    pending = false,
  }: {
    count: NavCount | null;
    stacked?: boolean;
    pending?: boolean;
  } = $props();

  // The counts after the total, in the order and with the zero rule the link's
  // name uses too (#1944): both come from pillParts.
  const parts = $derived(count ? pillParts(count) : []);
</script>

{#if pending}
  <!-- The first refresh has not finished (#1672), so the number is not known:
       a dash, never a 0. The link's own name says nothing about a count. -->
  <span class="nav-pills nav-pending" class:stacked aria-hidden="true">
    <span class="nav-total">&ndash;</span>
  </span>
{:else if count && count.total > 0}
  <span class="nav-pills" class:stacked aria-hidden="true">
    <span class="nav-total">{count.total}</span>
    {#each parts as part, i (part.kind)}
      <!-- A space before each count: Svelte trims the whitespace at the start of
           a block, and the pills read "15 2 10 3", not "152103", to a screen
           reader and to the label-in-name check. -->
      {" "}
      {#if part.kind === "failed"}
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
          >{part.n}</span
        >
      {:else if part.kind === "passed"}
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
          >{part.n}</span
        >
      {:else if part.kind === "running"}
        <!-- The hairline between the outcomes and the state. Decoration only,
           and only when an outcome sits before the running count: with the
           total alone before it, the total's own hairline does the job. -->
        {#if i > 0}
          <span class="nav-divider" aria-hidden="true"></span>
        {/if}
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
          >{part.n}</span
        >
      {:else if part.kind === "none"}
        <!-- A dashed circle: no run to be good or bad. Neutral ink. -->
        <span class="nav-count nav-none"
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
            ><circle cx="12" cy="12" r="10" stroke-dasharray="4 4" /></svg
          >{part.n}</span
        >
      {/if}
    {/each}
  </span>
{/if}

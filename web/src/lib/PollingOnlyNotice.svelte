<script lang="ts">
  import FilterPill from "./FilterPill.svelte";
  import { pollingOnlyNotice } from "./polling-only.js";

  // The amber notice Settings, Repositories and Branches share (#4028): how
  // many repos refresh on a schedule instead of instantly, with a pill that
  // narrows the list to them. Not drawn at zero.
  let {
    count,
    pressed,
    onpress,
    id,
  }: {
    count: number;
    pressed: boolean;
    onpress: () => void;
    id: string;
  } = $props();
</script>

{#if count > 0}
  <div class="polling-notice" {id} data-testid="polling-only-notice">
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8 1.75 14.5 13.5h-13z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
      />
      <path
        d="M8 6.5v3.25M8 11.5v.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
    <span class="polling-text">{pollingOnlyNotice(count)}</span>
    <FilterPill {pressed} onclick={onpress} data-testid="polling-only-pill">
      Show only these
    </FilterPill>
  </div>
{/if}

<style>
  .polling-notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin: 0 0 14px;
    padding: 8px 12px;
    border: 1px solid var(--warning);
    border-radius: 8px;
    background: var(--warning-bg);
    color: var(--text);
  }
  .polling-notice svg {
    flex: none;
    color: var(--warning);
  }
  .polling-text {
    flex: 1 1 14rem;
    font-size: 0.875rem;
  }
</style>

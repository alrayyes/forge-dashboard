<script lang="ts">
  import type { Snippet } from "svelte";

  // A labelled group of filter pills (#4279): the label is visible and names
  // the group, and the pills are `aria-pressed` buttons, one choice at a time.
  let {
    label,
    id,
    children,
  }: { label: string; id: string; children: Snippet } = $props();
</script>

<div class="filter-group" role="group" aria-labelledby="{id}-label">
  <span class="filter-group-label" id="{id}-label">{label}</span>
  <div class="filter-pills">
    {@render children()}
  </div>
</div>

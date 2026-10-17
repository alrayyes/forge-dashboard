<script lang="ts">
  // Placeholder rows for a list whose first refresh has not finished (#1672).
  // Hidden from assistive technology: the status line speaks for them, so the
  // rows are not read one by one. Not interactive, so no target size applies.
  let { rows = 4 }: { rows?: number } = $props();
</script>

<div class="list-skeleton" aria-hidden="true" data-testid="list-skeleton">
  {#each Array.from({ length: rows }, (_, i) => i) as i (i)}
    <div class="skeleton-row">
      <span class="skeleton-bar skeleton-bar-repo"></span>
      <span class="skeleton-bar skeleton-bar-title"></span>
      <span class="skeleton-bar skeleton-bar-meta"></span>
    </div>
  {/each}
</div>

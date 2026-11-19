<script lang="ts">
  import {
    type MainBranchCounts,
    statusCount,
    type StatusPill,
  } from "#lib/main-branches.js";
  import CiFilterPill from "#lib/CiFilterPill.svelte";

  // The status group of the Main branches filter (#1224): one pill per status
  // that some row has, in this order, with its count.
  const STATUS_PILLS: { key: StatusPill; label: string }[] = [
    { key: "all", label: "All" },
    { key: "failed", label: "Failing" },
    { key: "passed", label: "Passing" },
    { key: "running", label: "Running" },
    { key: "cancelled", label: "Cancelled" },
    { key: "awaiting_approval", label: "Waiting for approval" },
    { key: "unknown", label: "Unknown" },
    { key: "none", label: "No pipeline" },
  ];

  let {
    offered,
    counts,
    status,
    onselect,
  }: {
    offered: ReadonlySet<StatusPill>;
    counts: MainBranchCounts;
    status: StatusPill;
    onselect: (key: StatusPill) => void;
  } = $props();
</script>

<div class="mb-group" role="group" aria-label="Filter by status">
  {#each STATUS_PILLS.filter((p) => offered.has(p.key)) as { key, label } (key)}
    {#if key === "all"}
      <button
        type="button"
        class="mb-pill"
        aria-pressed={status === key}
        onclick={() => onselect(key)}
        >{label}
        <span class="mb-count">{statusCount(counts, key)}</span></button
      >
    {:else}
      <CiFilterPill
        status={key}
        class="mb-pill"
        aria-pressed={status === key}
        onclick={() => onselect(key)}
        >{label}
        <span class="mb-count">{statusCount(counts, key)}</span></CiFilterPill
      >
    {/if}
  {/each}
</div>

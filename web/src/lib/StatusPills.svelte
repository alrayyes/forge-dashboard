<script lang="ts">
  import {
    type MainBranchCounts,
    statusCount,
    type StatusPill,
  } from "#lib/main-branches.js";
  import FilterGroup from "#lib/FilterGroup.svelte";
  import FilterPill from "#lib/FilterPill.svelte";

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

<FilterGroup label="Status" id="mb-status">
  {#each STATUS_PILLS.filter((p) => offered.has(p.key)) as { key, label } (key)}
    <FilterPill
      status={key === "all" ? undefined : key}
      pressed={status === key}
      count={statusCount(counts, key)}
      onclick={() => onselect(key)}
    >
      {label}
    </FilterPill>
  {/each}
</FilterGroup>

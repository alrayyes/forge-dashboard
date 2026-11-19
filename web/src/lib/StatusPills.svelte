<script lang="ts">
  import {
    type MainBranchCounts,
    statusCount,
    type StatusPill,
  } from "#lib/main-branches.js";
  import { checkGlyphElements } from "#lib/ci-pill.js";

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

  // The CI pill's glyph for each status, the same shapes the rows draw. No
  // pipeline takes the skipped slash. All has no glyph.
  const GLYPH_STATE: Partial<Record<StatusPill, string>> = {
    failed: "failure",
    passed: "success",
    running: "running",
    cancelled: "cancelled",
    awaiting_approval: "awaiting_approval",
    unknown: "unknown",
    none: "skipped",
  };

  // Draws the glyphs ahead of the word. They are aria-hidden SVG, so the
  // button's name stays the word and count.
  function glyph(node: HTMLElement, state: string | undefined) {
    if (state) node.prepend(...checkGlyphElements(state));
  }

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
    <button
      type="button"
      class="mb-pill"
      data-status={key === "all" ? undefined : key}
      use:glyph={GLYPH_STATE[key]}
      aria-pressed={status === key}
      onclick={() => onselect(key)}
      >{label}
      <span class="mb-count">{statusCount(counts, key)}</span></button
    >
  {/each}
</div>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { checkGlyphElements } from "#lib/ci-pill.js";

  // A filter pill that wears a CI state: the glyph the row's CI pill draws,
  // before the word, tinted until pressed, then the state's own pair and a
  // ring (#4221, #4246). The Main branches status filter and the pull request
  // overview's CI filter both draw it, so one shape means one state on every
  // page. `status` is the Main branches vocabulary and sets the tone; a page
  // maps its own states onto it.
  export type CiFilterStatus =
    | "failed"
    | "passed"
    | "running"
    | "cancelled"
    | "awaiting_approval"
    | "unknown"
    | "none";

  // The CI pill's glyph state for each status. No pipeline takes the skipped
  // slash.
  const GLYPH_STATE: Record<CiFilterStatus, string> = {
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
  function glyph(node: HTMLElement, status: CiFilterStatus) {
    node.prepend(...checkGlyphElements(GLYPH_STATE[status]));
  }

  let {
    status,
    class: className = "",
    children,
    ...rest
  }: {
    status: CiFilterStatus;
    children: Snippet;
  } & HTMLButtonAttributes = $props();
</script>

<button
  type="button"
  {...rest}
  class="ci-filter-pill {className}"
  data-status={status}
  use:glyph={status}
>
  {@render children()}
</button>

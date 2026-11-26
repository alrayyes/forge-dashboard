<script module lang="ts">
  // The CI states a pill can wear, in the Main branches vocabulary that sets
  // the tone. A page maps its own states onto it.
  export type CiFilterStatus =
    | "failed"
    | "passed"
    | "running"
    | "cancelled"
    | "awaiting_approval"
    | "unknown"
    | "none";
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { ciFilterGlyph } from "#lib/ci-filter-glyph.js";

  // The one pill every filter group draws (#4279): 32px high, outlined, filled
  // with the accent when pressed, and a count in it. A group of these sits in a
  // FilterGroup, which labels it. `status` gives the pill the CI pill's glyph
  // and tone (#4221, #4246); without it the pill is plain. `pressed` is the
  // aria-pressed the group's single choice reads from. `countFirst` puts the
  // count before the words, for a pill that reads as a sentence: "3 behind the
  // base branch" (#4624).
  let {
    pressed,
    count,
    status,
    countFirst = false,
    class: className = "",
    children,
    ...rest
  }: {
    pressed: boolean;
    count?: number;
    status?: CiFilterStatus;
    countFirst?: boolean;
    children: Snippet;
  } & Omit<HTMLButtonAttributes, "aria-pressed"> = $props();
</script>

<button
  type="button"
  {...rest}
  class="filter-pill {status ? 'ci-filter-pill' : ''} {className}"
  aria-pressed={pressed}
  data-status={status}
  use:ciFilterGlyph={status}
>
  {#if countFirst && count !== undefined}
    <span class="filter-pill-count">{count}</span>
  {/if}
  {@render children()}
  {#if !countFirst && count !== undefined}
    <span class="filter-pill-count">{count}</span>
  {/if}
</button>

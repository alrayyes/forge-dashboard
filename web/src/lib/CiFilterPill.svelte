<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { type CiFilterStatus, ciFilterGlyph } from "#lib/ci-filter-glyph.js";

  // A filter pill that wears a CI state: the glyph the row's CI pill draws,
  // before the word, tinted until pressed, then the state's own pair and a
  // ring (#4221, #4246). The Main branches status filter and the pull request
  // overview's CI filter both draw it, so one shape means one state on every
  // page. `status` is the Main branches vocabulary and sets the tone; a page
  // maps its own states onto it.

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
  use:ciFilterGlyph={status}
>
  {@render children()}
</button>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  // A labelled group of filter pills (#4279): the label is visible and names
  // the group, and the pills are `aria-pressed` buttons, one choice at a time.
  // Other attributes land on the group itself, so a page can mark it (the pull
  // request page's `data-group`, `hidden`, and the class its sheet copy uses).
  let {
    label,
    id,
    class: className = "",
    children,
    ...rest
  }: {
    label: string;
    id: string;
    children: Snippet;
  } & Omit<
    HTMLAttributes<HTMLDivElement>,
    "role" | "aria-labelledby"
  > = $props();
</script>

<div
  {...rest}
  class="filter-group {className}"
  role="group"
  aria-labelledby="{id}-label"
>
  <span class="filter-group-label" id="{id}-label">{label}</span>
  <div class="filter-pills">
    {@render children()}
  </div>
</div>

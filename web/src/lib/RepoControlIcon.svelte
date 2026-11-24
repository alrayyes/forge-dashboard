<script lang="ts">
  // The glyphs of the per-repo controls, drawn inline like the app's other
  // icons: stroke currentColor, decorative. The control around one carries the
  // accessible name. Auto-update is git-merge, Rebase bots is the Bots nav
  // robot, Ignore is an eye with a slash and a caret for the menu.
  let {
    kind,
    size = 18,
  }: { kind: "auto-update" | "rebase-bots" | "ignore"; size?: number } =
    $props();
</script>

<svg
  class="repo-control-icon"
  viewBox="0 0 24 24"
  width={size}
  height={size}
  aria-hidden="true"
  focusable="false"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  {#if kind === "auto-update"}
    <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path
      d="M6 21V9a9 9 0 0 0 9 9"
    />
  {:else if kind === "rebase-bots"}
    <path d="M12 8V4H8" /><rect
      width="16"
      height="12"
      x="4"
      y="8"
      rx="2"
    /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path
      d="M9 13v2"
    />
  {:else}
    <path
      d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"
    /><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" /><path
      d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"
    /><path d="m2 2 20 20" /><path d="m16 20 3 3 3-3" />
  {/if}
</svg>

<script lang="ts">
  import type { Snippet } from "svelte";

  // A show/hide control for secondary help: a real button with aria-expanded
  // and aria-controls, closed by default, chevron up when open. The panel is
  // always in the DOM (hidden when closed) so aria-describedby can point at it.
  let {
    id,
    label,
    children,
  }: { id: string; label: string; children: Snippet } = $props();

  let open = $state(false);
</script>

<div class="disclosure">
  <button
    type="button"
    class="disclosure-toggle"
    id={`${id}-toggle`}
    aria-expanded={open}
    aria-controls={id}
    onclick={() => (open = !open)}
  >
    {label}
    <svg
      class="chevron"
      class:open
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2 4.5 6 8.5 10 4.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>
  <div class="disclosure-panel field-hint" {id} hidden={!open}>
    {@render children()}
  </div>
</div>

<style>
  .disclosure-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 0;
    background: none;
    border: 0;
    color: var(--accent);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .disclosure-toggle:hover {
    text-decoration: underline;
  }
  .chevron {
    transition: transform 0.15s;
  }
  .chevron.open {
    transform: rotate(180deg);
  }
  .disclosure-panel {
    margin-top: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .chevron {
      transition: none;
    }
  }
</style>

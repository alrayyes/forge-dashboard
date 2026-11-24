<script lang="ts">
  import RepoControlIcon from "./RepoControlIcon.svelte";

  // An icon toggle for one per-repo setting. The accessible name is fixed
  // ("Auto-update on <repo>") and `aria-pressed` carries the state, so a screen
  // reader never hears the label flip (W3C APG button pattern). Off is a dark
  // outlined icon in a square with a 2px border; On is a teal fill, a white
  // icon and a check badge fully inside the button, so the state is not the
  // colour alone. A request in flight shows a spinner and `aria-busy`, with the
  // name unchanged; a lock disables the button and `describedby` points at the
  // note that says why.
  let {
    kind,
    name,
    pressed,
    busy = false,
    disabled = false,
    describedby,
    onclick,
  }: {
    kind: "auto-update" | "rebase-bots";
    name: string;
    pressed: boolean;
    busy?: boolean;
    disabled?: boolean;
    describedby?: string;
    onclick: () => void;
  } = $props();
</script>

<span class="repo-control" data-tip={name}>
  <button
    type="button"
    class="repo-toggle"
    class:on={pressed}
    aria-label={name}
    aria-pressed={pressed}
    aria-busy={busy ? "true" : undefined}
    aria-describedby={describedby}
    {disabled}
    onclick={() => {
      if (!busy) onclick();
    }}
  >
    {#if busy}
      <svg
        class="repo-spinner"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      >
        <path d="M12 3a9 9 0 1 0 9 9" />
      </svg>
    {:else}
      <RepoControlIcon {kind} />
    {/if}
    {#if pressed && !busy}
      <svg
        class="repo-check"
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="8" cy="8" r="8" />
        <path
          d="m4.5 8.3 2.3 2.3 4.7-4.9"
          fill="none"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    {/if}
  </button>
</span>

<style>
  .repo-toggle {
    position: relative;
    box-sizing: border-box;
    width: 32px;
    height: 32px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--control-border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--ink);
    cursor: pointer;
  }
  .repo-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .repo-toggle.on {
    border-color: var(--pill-active);
    background: var(--pill-active);
    color: var(--accent-ink);
  }
  .repo-toggle:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .repo-toggle[aria-busy="true"] {
    cursor: progress;
  }
  .repo-check {
    position: absolute;
    right: 1px;
    bottom: 1px;
    fill: var(--accent-ink);
    stroke: var(--pill-active);
  }
  .repo-spinner {
    animation: repo-spin 0.9s linear infinite;
  }
  @keyframes repo-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .repo-spinner {
      animation: none;
    }
  }
  @media (max-width: 760px) {
    .repo-toggle {
      width: 40px;
      height: 40px;
    }
  }
</style>

<script lang="ts">
  import { swapLabel, tapOutcome } from "#lib/wait-chip-swap.js";

  // MOCKUP for #4942, not drawn by any page. One slot where an armed row's
  // "Waiting for CI" chip becomes the Update branch button. The slot keeps the
  // chip's 44px height and border, and its width is the widest of its three
  // labels, so nothing moves when the words swap and the row stays one line.
  //
  // The swap shows on mouse hover, on keyboard focus and on a first touch tap.
  // Enter, Space and a screen reader's click run Update branch at once, since
  // they have no hover to wait for (#4531). Cancel auto-merge is its own
  // button beside the words, in every state, so it is one Tab or one tap away.
  let {
    phase = "idle",
    lockReason = "Approve the waiting runs first, then it can run.",
    forceReveal = false,
    forceActive = false,
    onupdate,
    oncancel,
  }: {
    phase?: "idle" | "locked" | "inflight";
    lockReason?: string;
    // Story-only: draw the hover preview and the pressed look without a pointer.
    forceReveal?: boolean;
    forceActive?: boolean;
    onupdate?: () => void;
    oncancel?: () => void;
  } = $props();

  const uid = $props.id();
  let hovered = $state(false);
  let focused = $state(false);
  let tapped = $state(false);
  let explained = $state(false);
  let announcement = $state("");

  const locked = $derived(phase === "locked");
  const inFlight = $derived(phase === "inflight");
  const revealed = $derived(
    forceReveal || hovered || focused || tapped || explained,
  );
  const label = $derived(
    swapLabel({ revealed: revealed && !locked, inFlight }),
  );
  const detail = $derived(
    inFlight
      ? "Auto-merge follows when it lands"
      : locked && revealed
        ? lockReason
        : revealed
          ? "Then auto-merge goes on"
          : "Auto-merge armed",
  );

  // A first tap's reveal gives itself up after a few seconds, so a chip left
  // alone on a phone goes back to the wait.
  $effect(() => {
    if (!tapped) return;
    const timer = setTimeout(() => {
      tapped = false;
    }, 5000);
    return () => clearTimeout(timer);
  });

  function activate(event: MouseEvent) {
    if (inFlight) return;
    const outcome = tapOutcome({
      revealed: revealed,
      detail: event.detail,
      locked,
    });
    if (outcome === "reveal") {
      tapped = true;
      announcement = "Update branch is ready. Activate again to run it.";
    } else if (outcome === "explain") {
      explained = true;
      announcement = `Update branch is locked. ${lockReason}`;
    } else {
      tapped = false;
      announcement = "Updating branch.";
      onupdate?.();
    }
  }
</script>

<div
  class="slot"
  data-phase={phase}
  data-revealed={revealed && !locked && !inFlight ? "true" : undefined}
>
  <svg
    class="icon"
    class:wait-chip-spinner={phase !== "locked"}
    viewBox="0 0 16 16"
    width="16"
    height="16"
    aria-hidden="true"
  >
    {#if revealed && !inFlight}
      <path
        d="M8 13V4m0 0L4.5 7.5M8 4l3.5 3.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {:else}
      <circle
        cx="8"
        cy="8"
        r="5.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-dasharray="20 14"
        stroke-linecap="round"
      />
    {/if}
  </svg>

  <!-- One stable name for every state. It holds both visible labels, so the
       visible words are always part of it (WCAG 2.5.3). The reason sits in
       the description, and the change of words is not announced as it
       happens: the status line below speaks once per action. -->
  <div class="col">
    <button
      type="button"
      class="swap"
      class:pressed={forceActive}
      aria-label={inFlight
        ? "Waiting for CI, updating branch"
        : "Waiting for CI, update branch"}
      aria-describedby="{uid}-detail"
      aria-disabled={locked || inFlight ? "true" : undefined}
      aria-busy={inFlight ? "true" : undefined}
      onpointerenter={(e) => {
        if (e.pointerType === "mouse") hovered = true;
      }}
      onpointerleave={() => {
        hovered = false;
        explained = false;
      }}
      onfocus={(e) => {
        focused = e.currentTarget.matches(":focus-visible");
      }}
      onblur={() => {
        focused = false;
        tapped = false;
        explained = false;
      }}
      onclick={activate}
    >
      <span class="words" aria-hidden="true">
        <!-- Sizers: the three labels stacked, so the slot is as wide as the
           longest and never reflows. -->
        <span class="sizer">Waiting for CI</span>
        <span class="sizer">Update branch</span>
        <span class="sizer">Updating branch…</span>
        <span class="label">
          {#if locked && revealed}<svg
              class="lock"
              viewBox="0 0 16 16"
              width="12"
              height="12"
            >
              <path
                d="M5 7V5a3 3 0 0 1 6 0v2M4 7h8v6H4z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
            </svg>{/if}{locked && revealed ? "Update branch" : label}
        </span>
      </span>
    </button>
    <!-- Outside the button, so the button's visible text is only its label and
       the label sits inside its name (WCAG 2.5.3). -->
    <span class="detail" aria-hidden="true">{detail}</span>
    <span id="{uid}-detail" class="visually-hidden">
      Waiting for CI, auto-merge is armed.
      {#if locked}Update branch is locked. {lockReason}{/if}
    </span>
  </div>

  <button type="button" class="cancel" onclick={() => oncancel?.()}>
    Cancel auto-merge
  </button>

  <span class="visually-hidden" role="status">{announcement}</span>
</div>

<style>
  .slot {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    height: 44px;
    min-width: 0;
    padding: 0 8px;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    background: var(--surface-sunken);
    color: var(--ink);
  }
  .slot[data-revealed="true"] {
    border-color: var(--accent);
  }
  .slot[data-phase="locked"] {
    border-style: dashed;
  }
  .icon {
    flex: none;
  }
  .col {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    line-height: 1.25;
  }
  .swap {
    min-width: 0;
    display: flex;
    align-items: center;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
  }
  .swap[aria-disabled="true"] {
    cursor: default;
  }
  .swap:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .swap.pressed,
  .swap:not([aria-disabled="true"]):active {
    color: var(--accent);
    text-decoration: underline;
  }
  .words {
    display: grid;
    min-width: 0;
    line-height: 1.25;
  }
  .sizer {
    grid-area: 1 / 1;
    visibility: hidden;
    height: 0;
    overflow: hidden;
    font-size: 0.78125rem;
    font-weight: 700;
    white-space: nowrap;
  }
  .label {
    grid-area: 1 / 1;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.78125rem;
    font-weight: 700;
    white-space: nowrap;
  }
  .detail {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.6875rem;
    color: var(--ink-2);
  }
  .slot[data-revealed="true"] .label {
    color: var(--accent);
  }
  .cancel {
    flex: none;
    min-height: 30px;
    padding: 4px 11px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    font-size: 0.71875rem;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
  }
  .cancel:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>

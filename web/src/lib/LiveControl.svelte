<script lang="ts">
  // The one live control for a list card header (#3699): status dot and word,
  // the time of the snapshot shown, Pause or Resume, and a refresh icon. The
  // page owns what pausing and refreshing do; this draws them. The ids stay
  // because the dashboard wires the two buttons itself.
  import { onMount } from "svelte";
  import { liveStatus, pauseLabel, updatedText } from "#lib/live-control.js";

  let {
    paused,
    updatedAt,
    onpause,
    onrefresh,
    refreshing = false,
  }: {
    paused: boolean;
    updatedAt: string | null;
    onpause: () => void;
    onrefresh?: () => void;
    // True while a refresh the user asked for runs. aria-disabled, not
    // disabled, so the button keeps keyboard focus; a press is ignored.
    refreshing?: boolean;
  } = $props();

  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const updated = $derived(updatedText(updatedAt, now));
  const pause = $derived(pauseLabel(paused));
</script>

<div class="live-control" class:paused role="group" aria-label="Live updates">
  <span class="live-status"
    ><span class="live-dot" aria-hidden="true"></span>{liveStatus(paused)}</span
  >
  {#if updated}<span class="live-updated">{updated}</span>{/if}
  <button
    type="button"
    class="live-pause"
    id="pause-updates-button"
    aria-label={pause.name}
    onclick={onpause}>{pause.text}</button
  >
  <button
    type="button"
    class="live-refresh"
    class:is-refreshing={refreshing}
    id="force-refresh-button"
    aria-label="Refresh now"
    aria-disabled={refreshing ? "true" : undefined}
    title="Refresh now"
    onclick={() => {
      if (!refreshing) onrefresh?.();
    }}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      ><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg
    >
  </button>
</div>

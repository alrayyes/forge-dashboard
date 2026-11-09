<script lang="ts">
  import {
    dashboardRead,
    retryDashboardRead,
  } from "#lib/dashboard-read.svelte.js";

  // Says a read failed, for the pages that would otherwise show an empty page
  // as a real zero (#3212). By default it reports the layout's
  // /api/v1/dashboard read (dashboardReadFailureMessage). A page with a read
  // of its own passes `message` and `onretry` and gets the same banner and
  // wording (#3272).
  let { message, onretry }: { message?: string | null; onretry?: () => void } =
    $props();

  const text = $derived(
    message === undefined ? dashboardRead.lastError : message,
  );
</script>

{#if text}
  <div class="error-banner" role="alert">
    <span class="error-banner-text">{text}</span>
    <button
      type="button"
      class="error-banner-retry"
      onclick={onretry ?? retryDashboardRead}
    >
      Retry
    </button>
  </div>
{/if}

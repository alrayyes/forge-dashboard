<script lang="ts">
  import {
    dashboardRead,
    retryDashboardRead,
  } from "#lib/dashboard-read.svelte.js";

  // Says the layout's /api/v1/dashboard read failed, for the pages that draw
  // from it and would otherwise show an empty page as a real zero (#3212). The
  // wording comes from the layout (dashboardReadFailureMessage) and the styles
  // are the list pages' banner, so the two read the same.
</script>

{#if dashboardRead.lastError}
  <div class="error-banner" role="alert">
    <span class="error-banner-text">{dashboardRead.lastError}</span>
    <button
      type="button"
      class="error-banner-retry"
      onclick={retryDashboardRead}
    >
      Retry
    </button>
  </div>
{/if}

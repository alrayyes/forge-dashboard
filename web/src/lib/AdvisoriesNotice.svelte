<script lang="ts">
  // The notice on the Branches page when one forge's advisories can't be read
  // at all: what it was, as far as the server knows, and the page that explains
  // how to fix it. The page decides when to show it; this says what it says.
  import {
    ADVISORY_REASON_TEXT,
    advisoryReasonNeedsGrant,
    forgejoAdvisoryReasonText,
    type AdvisoryReason,
  } from "#lib/main-branches.js";

  let {
    forge,
    reason,
  }: {
    forge: "github" | "forgejo";
    // The one cause every unreadable row of this forge shares, or null when
    // the rows disagree or the server gave none.
    reason: Exclude<AdvisoryReason, "not_enabled"> | null;
  } = $props();

  const forgejoText = $derived(forgejoAdvisoryReasonText(reason));
</script>

{#if forge === "github"}
  <div class="mb-banner" role="status" data-testid="advisories-notice">
    <p>
      Advisories can't be read for your GitHub repositories, so none are shown.
      {#if reason}
        {ADVISORY_REASON_TEXT[reason]}
      {:else}
        Most likely the credential lacks the Dependabot alerts permission
        (read-only), or alerts are switched off on the repo. A rate limit or a
        GitHub error looks the same.
      {/if}
      {#if !reason || advisoryReasonNeedsGrant(reason)}
        A permission you just accepted can take up to an hour and a quarter to
        show; saving Settings reads them again at once. <a
          href="https://github.com/alrayyes/forge-dashboard/blob/main/docs/main-branches.md#when-advisories-cant-be-read"
          target="_blank"
          rel="noopener noreferrer"
          >How to grant it<span class="sr-only"> (opens in a new tab)</span></a
        >.
      {/if}
    </p>
  </div>
{:else}
  <div class="mb-banner" role="status" data-testid="forgejo-advisories-notice">
    <p>
      Advisories can't be read for your Forgejo repositories, so none are shown.
      {#if forgejoText}
        {forgejoText}
      {:else}
        OSV may be unreachable, or a lock file could not be read, was over 8
        megabytes or lists too many packages.
      {/if}
      <a
        href="https://github.com/alrayyes/forge-dashboard/blob/main/docs/main-branches.md#forgejo-advisories"
        target="_blank"
        rel="noopener noreferrer"
        >How Forgejo advisories are read<span class="sr-only">
          (opens in a new tab)</span
        ></a
      >.
    </p>
  </div>
{/if}

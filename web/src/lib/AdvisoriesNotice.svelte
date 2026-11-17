<script lang="ts">
  // The notice on the Branches page when one forge's advisories can't be read
  // at all: what it was, as far as the server knows, and the page that explains
  // how to fix it. The page decides when to show it; this says what it says.
  // The wording is keyed by the forge's advisory source, not by its name.
  import { forgeLabelOf } from "#lib/forges.js";
  import {
    advisoryReasonNeedsGrant,
    advisoryReasonText,
    advisoryWordsFor,
    type AdvisoryReason,
  } from "#lib/main-branches.js";

  let {
    forge,
    reason,
  }: {
    forge: string;
    // The one cause every unreadable row of this forge shares, or null when
    // the rows disagree or the server gave none.
    reason: Exclude<AdvisoryReason, "not_enabled"> | null;
  } = $props();

  const words = $derived(advisoryWordsFor(forge));
  const label = $derived(forgeLabelOf(forge));
  // The permission steps, and the page that explains them, are said only when a
  // grant could fix it: no cause named, or one a grant fixes.
  const grantApplies = $derived(!reason || advisoryReasonNeedsGrant(reason));
  const reasonText = $derived(
    reason ? advisoryReasonText(forge, reason) : undefined,
  );
</script>

<div class="mb-banner" role="status" data-testid={words.testId}>
  <p>
    Advisories can't be read for your {label} repositories, so none are shown.
    {#if reasonText}
      {reasonText}
    {:else}
      {words.fallback}
    {/if}
    {#if words.grantNote && grantApplies}
      {words.grantNote}
    {/if}
    {#if words.help && (!words.grantNote || grantApplies)}
      <a href={words.help.href} target="_blank" rel="noopener noreferrer"
        >{words.help.text(label)}<span class="sr-only">
          (opens in a new tab)</span
        ></a
      >.
    {/if}
  </p>
</div>

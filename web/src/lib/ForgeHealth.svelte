<script lang="ts">
  // The toolbar's forge health: a chip while a forge is starting up or rate
  // limited, the note that its rows are old, each budget with a label, and the
  // cause of an outage. A healthy forge draws nothing (#3681) and an outage is
  // the banner's to say (#3719); the live region speaks both.
  import { FORGE_LABELS } from "#lib/forges.js";
  import {
    chipClass,
    chipLabel,
    isOutage,
    isUnreachable,
    needsChip,
    staleNote,
    type StartingHealth,
  } from "#lib/forge-starting.js";
  import {
    budgetText,
    isRateLimited,
    showsOnOverview,
    type RateLimit,
  } from "#lib/rate-limit.js";

  type Forge = StartingHealth & {
    error?: string;
    rateLimitREST?: RateLimit;
    rateLimitGraphQL?: RateLimit;
  };

  let {
    forges,
    ago,
  }: {
    forges: Forge[];
    // The age of the rows, as the page words it ("5m ago").
    ago: (iso: string) => string;
  } = $props();

  const SHORT_LABELS: Record<string, string> = { github: "GH", forgejo: "FJ" };

  // One friendly, actionable line per error kind, taking precedence over the
  // raw error string. "unreachable" names the refresh button as the way to
  // retry now, not just "wait."
  const ERROR_HEADLINES: Record<string, string> = {
    unreachable:
      "Temporarily unreachable — try the refresh button above, or it’ll retry automatically.",
    upstream_error:
      "The forge answered with a server error — it’ll retry automatically.",
    unauthorized: "Check the token in Settings.",
    not_found: "Check the instance URL in Settings.",
    rate_limited: "Rate limit exceeded.",
  };

  const name = (f: Forge) => FORGE_LABELS[f.forge] || f.forge;
  const headline = (f: Forge) =>
    (f.errorKind && ERROR_HEADLINES[f.errorKind]) ||
    `Something went wrong talking to ${name(f)}.`;
  const limited = (f: Forge) =>
    isRateLimited(f.rateLimitREST) || isRateLimited(f.rateLimitGraphQL);
  const budgets = (f: Forge) =>
    (
      [
        ["GraphQL", f.rateLimitGraphQL],
        ["REST", f.rateLimitREST],
      ] as const
    )
      .filter(([, b]) => b && showsOnOverview(b))
      .map(([kind, b]) =>
        budgetText(`${SHORT_LABELS[f.forge] || f.forge} ${kind}`, b!),
      );
  // An unreachable forge is the banner's: no chip, no age line, no cause line.
  // One that is rate limited as well has no unreachable banner, so it keeps all
  // three.
  const shown = (f: Forge) => !(isOutage(f) && !limited(f));
  // The rows of an unreachable forge are its last good ones (#933), plain text
  // for every error kind.
  const note = (f: Forge) =>
    f.staleSince ? staleNote(f, ago(f.staleSince)) : null;
  // The reason is real text, not a hover title: a tooltip never reaches touch.
  // The raw string sits in a native <details>. rate_limited has its own banner.
  const cause = (f: Forge) =>
    isUnreachable(f) && !!f.error && f.errorKind !== "rate_limited";
</script>

{#each forges.filter(shown) as f (f.forge)}
  {@const lines = budgets(f)}
  {@const age = note(f)}
  {#if needsChip(f, limited(f)) || age || lines.length > 0 || cause(f)}
    <div class="forge-health-item">
      {#if needsChip(f, limited(f))}
        <span class={chipClass(f)}
          ><span class="pulse-dot"></span>{chipLabel(name(f), f)}</span
        >
      {/if}
      {#if age}<span class="forge-health-stale">{age}</span>{/if}
      <!-- The numbers change on every poll, so they stay out of the live region. -->
      {#each lines as line (line)}
        <span class="forge-health-budget" aria-live="off">{line}</span>
      {/each}
      {#if cause(f)}
        <span class="forge-health-error">{headline(f)}</span>
        <details class="forge-health-detail">
          <summary>Show details</summary>{f.error}
        </details>
      {/if}
    </div>
  {/if}
{/each}

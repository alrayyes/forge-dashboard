<script module lang="ts">
  import type { CheckCounts } from "#lib/check-counts.js";

  // The row a Main branches pill was pressed on.
  export type PipelineTarget = {
    forge: string;
    fullName: string;
    branch: string;
    // Where the run is on the forge; empty when the forge named none.
    runUrl: string;
    // What the row said about its CI when the panel opened, to tell later
    // whether the pipeline behind the panel moved on.
    status: string;
    checks: CheckCounts;
    // The control to give focus back to when the panel closes.
    opener: HTMLElement | null;
  };
</script>

<script lang="ts">
  // The pipeline panel for a default branch: the jobs of its newest pipeline,
  // with the states, durations and links the pull request board's panel shows,
  // drawn with the same classes. The list comes from
  // GET /api/main-branches/checks, fetched when the panel opens and never as
  // part of the snapshot. The page calls open() from a row's pill, and follow()
  // with each list it reads: the panel reads again only when its own row's CI
  // changed, so a finished pipeline costs no more requests.
  import { CHECK_GLYPHS } from "#lib/check-glyphs.js";
  import { FORGE_LABELS } from "#lib/forges.js";
  import {
    CHECK_STATE_LABELS,
    formatCheckDuration,
    type Check,
  } from "#lib/pipeline-checks.js";
  import {
    announceChange,
    ciSignature,
    createLiveChecks,
    keepOrder,
    type LiveChecks,
  } from "#lib/pipeline-live.js";
  import type { MainBranch } from "#lib/main-branches.js";

  let dialog: HTMLDialogElement;
  let target = $state<PipelineTarget | null>(null);
  let phase = $state<"loading" | "ready" | "error">("loading");
  let checks = $state<Check[]>([]);
  let message = $state("");
  // Only the newest request may draw: an older answer arriving late is dropped.
  let request = 0;
  let live: LiveChecks | null = null;
  // Set when a read made for a change failed: the checks on screen may be old.
  let staleNote = $state("");
  // The one polite line a changed check earns.
  let announcement = $state("");

  export function open(next: PipelineTarget) {
    target = next;
    staleNote = "";
    announcement = "";
    live = createLiveChecks({
      signature: ciSignature({
        ci: next.status,
        checks: next.checks,
        runUrl: next.runUrl,
      }),
      paused: () => false,
      reload: () => target && load(target, true),
      onStale: () => {},
    });
    load(next);
    dialog.showModal();
  }

  // The page hands over each list it reads. A row whose CI moved on is what
  // sends the panel back to the forge.
  export function follow(branches: MainBranch[]) {
    if (!target || !live) return;
    const now = branches.find(
      (b) => b.forge === target?.forge && b.fullName === target?.fullName,
    );
    live.seen(
      now
        ? ciSignature({
            ci: now.status,
            checks: now.checks,
            runUrl: now.runUrl,
          })
        : null,
    );
  }

  async function load(row: PipelineTarget, again = false) {
    const mine = ++request;
    if (!again) {
      phase = "loading";
      checks = [];
    }
    try {
      const res = await fetch(
        `/api/main-branches/checks?forge=${encodeURIComponent(row.forge)}&fullName=${encodeURIComponent(row.fullName)}`,
        { headers: { Accept: "application/json" } },
      );
      if (mine !== request) return;
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error || `backend answered ${res.status}`);
      }
      if (mine !== request) return;
      const next: Check[] = body?.checks ?? [];
      if (again) {
        // Each pill changes where it stands; nothing moves or redraws when no
        // check changed.
        const ordered = keepOrder(checks, next);
        staleNote = "";
        if (JSON.stringify(ordered) === JSON.stringify(checks)) return;
        const message = announceChange(checks, ordered);
        checks = ordered;
        if (message) announcement = message;
        return;
      }
      live?.refreshed();
      checks = next;
      phase = "ready";
    } catch (err) {
      if (mine !== request) return;
      if (again) {
        staleNote = "Couldn't refresh these checks. They may be out of date.";
        return;
      }
      message = `Couldn't load the pipeline jobs for ${row.fullName}: ${err instanceof Error ? err.message : String(err)}`;
      phase = "error";
    }
  }

  // Fires for every way the panel closes: Escape, the close button and a click
  // on the backdrop.
  function closed() {
    request++;
    live = null;
    target?.opener?.focus();
    target = null;
  }

  // The backdrop is not a separate element: a click that lands on the dialog
  // itself, rather than on something inside it, is a click outside the panel.
  function outside(event: MouseEvent) {
    if (event.target === dialog) dialog.close();
  }

  const forgeName = $derived(
    target ? (FORGE_LABELS[target.forge] ?? target.forge) : "",
  );
</script>

<dialog
  bind:this={dialog}
  class="pipeline-dialog"
  aria-label="Pipeline checks"
  onclose={closed}
  onclick={outside}
>
  <div class="pipeline-dialog-header">
    <div>
      <h2 class="pipeline-dialog-title">Pipeline checks</h2>
      <p class="pipeline-dialog-subtitle">
        {#if target}{target.fullName}{target.branch
            ? ` · ${target.branch}`
            : ""}{/if}
      </p>
    </div>
    <button
      type="button"
      class="pipeline-dialog-close"
      aria-label="Close pipeline checks"
      onclick={() => dialog.close()}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"><path d="M18 6 6 18" /><path d="M6 6l12 12" /></svg
      >
    </button>
  </div>
  {#if staleNote}
    <p class="pipeline-paused-note" aria-live="polite">{staleNote}</p>
  {/if}
  <p class="sr-only" aria-live="polite">{announcement}</p>
  <div class="pipeline-dialog-body">
    {#if phase === "loading"}
      <p class="pipeline-status">Loading jobs…</p>
    {:else if phase === "error"}
      <div class="pipeline-error" role="alert">
        <p>{message}</p>
        <button
          type="button"
          class="row-action"
          onclick={() => target && load(target)}>Retry</button
        >
      </div>
    {:else if checks.length === 0}
      <p class="pipeline-status">No jobs were found for this branch.</p>
    {:else}
      <ul class="pipeline-check-list">
        <!-- Unkeyed: two jobs can share a name with no page, and the list is
             replaced whole on every load. -->
        {#each checks as check}
          <li class="pipeline-check">
            <span class="pipeline-check-status {check.state}">
              {#each CHECK_GLYPHS[check.state] ?? [] as g (g.name)}
                <svg
                  viewBox="0 0 16 16"
                  class="check-glyph check-glyph-{g.name}"
                  data-glyph={g.name}
                  aria-hidden="true"
                  focusable="false"
                >
                  <!-- nosemgrep: svelte-at-html -- g.body comes only from the static CHECK_GLYPHS constant in #lib/check-glyphs, never from forge data -->
                  {@html g.body}
                </svg>
              {:else}
                <span class="dot"></span>
              {/each}
              {CHECK_STATE_LABELS[check.state] || check.state}
            </span>
            <span class="pipeline-check-name">{check.name}</span>
            {#if check.durationSeconds !== undefined}
              <span class="pipeline-check-duration"
                >{formatCheckDuration(check.durationSeconds)}</span
              >
            {/if}
            <!-- A skipped job never ran, and a job with no page has nowhere
                 to go: no link, never an empty href. -->
            {#if check.state !== "skipped" && check.url}
              <a
                class="pipeline-check-link"
                href={check.url}
                target="_blank"
                rel="noopener"
                aria-label="View run: {check.name}">View run</a
              >
            {/if}
            {#if check.failedStep}
              <p class="pipeline-check-step">Failed step: {check.failedStep}</p>
            {/if}
            {#if check.excerpt}
              <!-- Text only: the log is never parsed as markup. It scrolls, so
                   it takes focus to be reachable from the keyboard. -->
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <pre
                class="pipeline-check-excerpt"
                tabindex="0"
                aria-label="Log excerpt: {check.name}">{check.excerpt}</pre>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if target?.runUrl}
      <p class="pipeline-run">
        <a
          class="pipeline-check-link"
          href={target.runUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open run on {forgeName} (opens in a new tab)"
          >Open run on {forgeName}</a
        >
      </p>
    {/if}
  </div>
</dialog>

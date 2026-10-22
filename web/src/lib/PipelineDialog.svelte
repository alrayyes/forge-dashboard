<script module lang="ts">
  // What a board hands the dialog to open it: a pull request, a bot's pull
  // request or a branch. The dialog owns the loading and error states, the
  // steps list, the live updates, the close and the way back to the opener; the
  // board owns what only it knows.
  export type PipelineTarget = {
    // The line under the title: "owner/repo#12", or "owner/repo · main".
    subtitle: string;
    // The GET endpoint that answers { checks }, read when the dialog opens and
    // never as part of a snapshot.
    checksUrl: string;
    // The row's ciSignature when the dialog opened, to tell later whether the
    // pipeline behind it moved on.
    signature: string;
    // What the dialog says when the list is empty, and how it starts a failed
    // read's message (the reason follows).
    emptyText: string;
    errorText: string;
    // Where the run is on the forge, when the forge named one.
    runUrl?: string;
    forgeName?: string;
    // Live updates are paused: no request, whatever changed.
    paused?: () => boolean;
    // The control to give focus back to when the dialog closes.
    opener?: HTMLElement | null;
    // Runs after the dialog closed, whichever way it closed.
    onClose?: () => void;
    // A control drawn above the list, such as the pull request board's rerun
    // button. Drawn again whenever the checks change; `failed` says whether any
    // check failed or timed out.
    // The call is untracked, so the control must redraw itself when anything
    // else it reads changes (the Main branches page does, after each poll).
    controls?: (failed: boolean) => HTMLElement | null;
  };
</script>

<script lang="ts">
  // The pipeline dialog for every board: the pull request and bot boards and
  // the Main branches page. The page calls open() from a row's pill, and
  // follow() with the row's signature from each snapshot it reads: the dialog
  // reads again only when its own row's CI changed, so a finished pipeline
  // costs no more requests.
  import { tick, untrack } from "svelte";
  import CheckRunOutput from "#lib/CheckRunOutput.svelte";
  import { FORGE_LABELS } from "#lib/forges.js";
  import { CHECK_GLYPHS } from "#lib/check-glyphs.js";
  import { createSpeaker } from "#lib/live-region.js";
  import {
    blockingFirst,
    CHECK_STATE_LABELS,
    formatCheckDuration,
    groupChecks,
    isBlocking,
    type Check,
  } from "#lib/pipeline-checks.js";
  import {
    announceChange,
    checkKeys,
    createLiveChecks,
    keepOrder,
    type LiveChecks,
  } from "#lib/pipeline-live.js";

  let dialog: HTMLDialogElement;
  let target = $state<PipelineTarget | null>(null);
  let phase = $state<"loading" | "ready" | "error">("loading");
  let checks = $state<Check[]>([]);
  let message = $state("");
  // Only the newest request may draw: an older answer arriving late is dropped.
  let request = 0;
  let live: LiveChecks | null = null;
  // Updates are paused, or a read made for a change failed: the checks on
  // screen may be old.
  let staleNote = $state("");
  // The one polite line a changed check earns.
  let announcement = $state("");
  const speak = createSpeaker((text) => {
    announcement = text;
  });

  export function open(next: PipelineTarget) {
    // Already open: showModal() would throw, and the dialog is modal, so only
    // a stray second call gets here.
    if (dialog.open) return;
    target = next;
    staleNote = "";
    speak.clear();
    live = createLiveChecks({
      signature: next.signature,
      paused: () => next.paused?.() ?? false,
      reload: () => target && load(target, true),
      onStale: (stale) => {
        staleNote = stale
          ? "Live updates are paused. These checks may be out of date."
          : "";
      },
    });
    load(next);
    dialog.showModal();
  }

  // The board hands over the open row's signature from each snapshot it reads,
  // or null when the row is gone. A row whose CI moved on is what sends the
  // dialog back to the forge.
  export function follow(signature: string | null) {
    live?.seen(signature);
  }

  // Live updates were turned back on.
  export function resume() {
    live?.resume();
  }

  async function load(row: PipelineTarget, wantAgain = false) {
    // A change before the first read has drawn restarts that read.
    const again = wantAgain && phase === "ready";
    const mine = ++request;
    if (!again) {
      phase = "loading";
      checks = [];
      staleNote = "";
    }
    try {
      const res = await fetch(row.checksUrl, {
        headers: { Accept: "application/json" },
      });
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
        // Each check changes where it stands; nothing moves or redraws when no
        // check changed.
        const ordered = keepOrder(checks, next);
        staleNote = "";
        if (JSON.stringify(ordered) === JSON.stringify(checks)) return;
        const line = announceChange(checks, ordered);
        const hadFocus = dialog
          .querySelector(".pipeline-dialog-body")
          ?.contains(document.activeElement);
        checks = ordered;
        if (line) speak(line);
        // The control the keyboard was on is gone: its node went with it, so
        // focus goes to the close button instead of the page behind.
        if (hadFocus) {
          await tick();
          if (!dialog.contains(document.activeElement))
            dialog
              .querySelector<HTMLElement>(".pipeline-dialog-close")
              ?.focus({ preventScroll: true });
        }
        return;
      }
      live?.refreshed();
      checks = blockingFirst(next);
      phase = "ready";
    } catch (err) {
      if (mine !== request) return;
      if (again) {
        live?.failed();
        staleNote = "Couldn't refresh these checks. They may be out of date.";
        return;
      }
      message = `${row.errorText}: ${err instanceof Error ? err.message : String(err)}`;
      phase = "error";
    }
  }

  // Fires for every way the dialog closes: Escape, the close button and a click
  // on the backdrop.
  function closed() {
    request++;
    live = null;
    speak.clear();
    const done = target;
    target = null;
    done?.opener?.focus();
    done?.onClose?.();
  }

  // The backdrop is not a separate element: a click that lands on the dialog
  // itself, rather than on something inside it, is a click outside it.
  function outside(event: MouseEvent) {
    if (event.target === dialog) dialog.close();
  }

  // The forge's name for a board that doesn't name it: the checks url carries
  // the forge.
  function forgeLabel(t: PipelineTarget): string {
    const forge = new URLSearchParams(t.checksUrl.split("?")[1] ?? "").get(
      "forge",
    );

    return t.forgeName ?? FORGE_LABELS[forge ?? ""] ?? forge ?? "the forge";
  }

  // Each check's key, so a redraw keeps a node, and the focus on it, with the
  // check it was drawn for when others come or go.
  const keyOf = $derived(
    new Map(checkKeys(checks).map((key, i) => [checks[i], key])),
  );
  const groups = $derived(groupChecks(checks));
  const failed = $derived(
    checks.some((c) => c.state === "failure" || c.state === "timed_out"),
  );

  // The board's own control, drawn again with each change of the checks. A
  // control the keyboard was on keeps focus.
  function controls(host: HTMLElement) {
    void checks;
    // Untracked: the control reads the page's snapshot (its lock, its row) and
    // redraws itself when that changes, so a poll must not rebuild it.
    const isFailed = failed;
    const node = untrack(() => target?.controls?.(isFailed)) ?? null;
    // The button the keyboard was on, by its place among the control's buttons
    // (Rerun, then a failure's Copy), so it keeps focus when the control is drawn
    // again.
    const buttons = () =>
      Array.from(host.querySelectorAll<HTMLElement>("button"));
    const was = buttons().indexOf(document.activeElement as HTMLElement);
    // Focus the control itself held, when its button had gone (a lock).
    const onControl = was < 0 && host.contains(document.activeElement);
    host.replaceChildren(...(node ? [node] : []));
    if (node && was >= 0) {
      const now = buttons();
      (now[was] ?? now[0])?.focus({ preventScroll: true });
    } else if (node && onControl) {
      node.tabIndex = -1;
      node.focus({ preventScroll: true });
    }
  }
</script>

{#snippet list(items: Check[])}
  <ul class="pipeline-check-list">
    <!-- Keyed by name, and the nth of a shared name: two jobs can share a name
         with no page. -->
    {#each items as check (keyOf.get(check))}
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
        {#if isBlocking(check)}
          <span class="pipeline-check-flag">Blocking</span>
        {/if}
        <!-- A skipped job never ran, and a job with no page has nowhere to go:
             no link, never an empty href, which would resolve to this page. A
             held workflow's own page is where the forge's approve button is. -->
        {#if check.state !== "skipped" && check.state !== "awaiting_approval" && check.jobId && check.url && target?.checksUrl}
          <CheckRunOutput
            name={check.name}
            jobId={check.jobId}
            checksUrl={target.checksUrl}
            runUrl={check.url}
            forgeName={forgeLabel(target)}
          />
        {:else if check.state !== "skipped" && check.url}
          {@const linkText =
            check.state === "awaiting_approval"
              ? "Approve on GitHub"
              : "View run"}
          <a
            class="pipeline-check-link"
            href={check.url}
            target="_blank"
            rel="noopener"
            aria-label="{linkText}: {check.name}">{linkText}</a
          >
        {/if}
        {#if check.failedStep}
          <p class="pipeline-check-step">Failed step: {check.failedStep}</p>
        {/if}
        {#if check.excerpt}
          <!-- Text only: the log is never parsed as markup. It scrolls, so it
               takes focus to be reachable from the keyboard. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <pre
            class="pipeline-check-excerpt"
            tabindex="0"
            aria-label="Log excerpt: {check.name}">{check.excerpt}</pre>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<dialog
  bind:this={dialog}
  id="pipeline-dialog"
  class="pipeline-dialog"
  aria-label="Pipeline checks"
  onclose={closed}
  onclick={outside}
>
  <div class="pipeline-dialog-header">
    <div>
      <h2 class="pipeline-dialog-title">Pipeline checks</h2>
      <p class="pipeline-dialog-subtitle">{target?.subtitle ?? ""}</p>
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
  <p class="pipeline-paused-note" aria-live="polite" hidden={!staleNote}>
    {staleNote}
  </p>
  <p class="sr-only pipeline-live-status" aria-live="polite">{announcement}</p>
  <div class="pipeline-dialog-body">
    {#if phase === "loading"}
      <p class="pipeline-status">Loading checks…</p>
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
      <p class="pipeline-status">{target?.emptyText ?? ""}</p>
    {:else}
      <div class="pipeline-controls" {@attach controls}></div>
      {#each groups as group (group.id)}
        {#if group.id === ""}
          {@render list(group.checks)}
        {:else}
          <div class="pipeline-group" role="group" aria-labelledby={group.id}>
            <h3 class="pipeline-group-title" id={group.id}>
              {group.title} ({group.checks.length})
            </h3>
            {@render list(group.checks)}
          </div>
        {/if}
      {/each}
    {/if}
    {#if target?.runUrl}
      <p class="pipeline-run">
        <a
          class="pipeline-check-link"
          href={target.runUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open run on {target.forgeName} (opens in a new tab)"
          >Open run on {target.forgeName}</a
        >
      </p>
    {/if}
  </div>
</dialog>

<style>
  /* The slot the board's own control is drawn into adds no box of its own. */
  .pipeline-controls {
    display: contents;
  }
</style>

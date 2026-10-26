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
    // Offers Cancel run for each queued or running Actions run among the
    // checks. `allowed` is the board's own rule, read each time the checks
    // change: the pull request board passes whether the server offers
    // cancel_run, a branch has no such list and omits it.
    cancel?: { forge: string; fullName: string; allowed?: () => boolean };
  };

  // Repositories whose token was refused permission to cancel, with the forge's
  // reason, kept for the page's life so the next dialog on that repository
  // doesn't offer a button it already knows will fail.
  const cancelLocks = new Map<string, { message: string; at: number }>();
  // A refused permission is remembered for this long. The token may be fixed
  // meanwhile, and the next try then simply works, so the lock is a short rest
  // and not a verdict.
  const LOCK_MS = 5 * 60_000;
</script>

<script lang="ts">
  // The pipeline dialog for every board: the pull request and bot boards and
  // the Main branches page. The page calls open() from a row's pill, and
  // follow() with the row's signature from each snapshot it reads: the dialog
  // reads again only when its own row's CI changed, so a finished pipeline
  // costs no more requests.
  import { tick, untrack } from "svelte";
  import CheckRunOutput from "#lib/CheckRunOutput.svelte";
  import CopyCheckLog from "#lib/CopyCheckLog.svelte";
  import { FORGE_LABELS } from "#lib/forges.js";
  import { CHECK_GLYPHS } from "#lib/check-glyphs.js";
  import { createSpeaker } from "#lib/live-region.js";
  import {
    canCopyLog,
    checkControl,
    checkLinkLabel,
    checkLinkText,
    forgeOf,
  } from "#lib/run-log.js";
  import {
    activeRuns,
    cancelLocksRepo,
    cancelText,
    cancelRun,
    runStopped,
    runLabel,
    type ActiveRun,
  } from "#lib/cancel-run.js";
  import {
    blockingFirst,
    CHECK_STATE_LABELS,
    checkRunKey,
    formatCheckDuration,
    groupChecks,
    isBlocking,
    type Check,
  } from "#lib/pipeline-checks.js";
  import {
    excerptKey,
    fillExcerpts,
    newExcerptReads,
    pickExcerptJobs,
  } from "#lib/pipeline-excerpts.js";
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

  // Forgejo's list carries no log excerpt, so a failed check shows at once with
  // its link and the excerpt is filled in as each read lands. Keyed by
  // excerptKey; `reads` keeps a check from being asked for twice and holds the
  // five reads of one open, retries included, and a new number stops reads
  // still waiting from an earlier open.
  let excerpts = $state<Record<string, string>>({});
  let reads = newExcerptReads();
  let excerptRun = 0;

  // Cancel run: one entry per run the person has started to cancel, by run id.
  // `confirm` waits for the second click, `cancelling` is the forge accepting,
  // `stalled` is the forge accepting but the run still going after the last
  // re-read, `cancelled` is a snapshot that no longer shows the run going, and
  // `refused` keeps the forge's own reason.
  type RunState = {
    phase: "confirm" | "cancelling" | "stalled" | "cancelled" | "refused";
    run: ActiveRun;
    message?: string;
  };
  let runStates = $state<Record<number, RunState>>({});
  // Bumped when a repository is locked, so the lock redraws.
  let lockTick = $state(0);
  // Bumped to draw the board's control again.
  let controlsTick = $state(0);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let lockTimer: ReturnType<typeof setTimeout> | undefined;
  // Whether any re-read since the cancel was accepted came back.
  let settleRead = false;
  const SETTLE_MS = 2500;
  const SETTLE_TRIES = 8;

  const cancelKey = (c: { forge: string; fullName: string }) =>
    `${c.forge}|${c.fullName}`;
  const cancelLock = $derived.by(() => {
    void lockTick;
    if (!target?.cancel) return "";
    const key = cancelKey(target.cancel);
    const lock = cancelLocks.get(key);
    if (!lock) return "";
    return Date.now() - lock.at > LOCK_MS ? "" : lock.message;
  });
  // The runs that can be cancelled, as the checks now name them.
  const runs = $derived(
    target?.cancel && (target.cancel.allowed?.() ?? true)
      ? activeRuns(checks)
      : [],
  );
  // What the section draws: the runs still going, and any run the person has
  // acted on whose state still has something to say.
  const runEntries = $derived.by(() => {
    // A run the person has acted on keeps the name it had when they did: the
    // label depends on the other runs, and one finishing mustn't rename the
    // run a confirm step is asking about.
    const rows: { run: ActiveRun; state?: RunState }[] = runs.map((run) => {
      const state = runStates[run.runId];
      return {
        run: state
          ? { ...run, label: state.run.label, bare: state.run.bare }
          : run,
        state,
      };
    });
    for (const state of Object.values(runStates)) {
      if (!runs.some((r) => r.runId === state.run.runId))
        rows.push({ run: state.run, state });
    }
    return rows;
  });

  function startCancel(run: ActiveRun) {
    runStates[run.runId] = { phase: "confirm", run };
    void tick().then(() =>
      dialog
        .querySelector<HTMLElement>(`[data-cancel-confirm="${run.runId}"]`)
        ?.focus({ preventScroll: true }),
    );
  }

  function keepRunning(run: ActiveRun) {
    delete runStates[run.runId];
    void tick().then(() =>
      dialog
        .querySelector<HTMLElement>(`[data-cancel-run="${run.runId}"]`)
        ?.focus({ preventScroll: true }),
    );
  }

  async function confirmCancel(run: ActiveRun) {
    const cancel = target?.cancel;
    if (!cancel) return;
    const row = target;
    runStates[run.runId] = { phase: "cancelling", run };
    try {
      await cancelRun(cancel, run.runId);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const message = e.message || "The forge refused to cancel this run.";
      // That the token may not cancel is true of the repository whichever
      // dialog is open, so the lock is kept. What the person sees and hears is
      // for the dialog they asked in: a refusal that lands after it closed
      // must not turn up in the next one.
      if (cancelLocksRepo(e)) {
        cancelLocks.set(cancelKey(cancel), { message, at: Date.now() });
        lockTick++;
        // Redraw when the rest is over, in a dialog that is still open.
        if (row && target === row) armLockTimer(cancel);
      }
      if (!row || target !== row) return;
      runStates[run.runId] = { phase: "refused", run, message };
      speak(`Couldn't cancel ${runLabel(run)}. ${message}`);
      // A run that already finished is the commonest refusal: read again so
      // the list says so.
      void load(row, true);
      return;
    }
    if (!row || target !== row) return;
    speak(`Cancelling ${runLabel(run)}.`);
    settleRead = false;
    settle(row, SETTLE_TRIES);
  }

  // The forge takes a moment to stop a run, and the board's own snapshot may be
  // slower still, so read the checks again a few times until the run is gone.
  function settle(row: PipelineTarget | null, left: number) {
    clearTimeout(settleTimer);
    if (!row || target !== row) return;
    if (!Object.values(runStates).some((s) => s.phase === "cancelling")) return;
    if (left <= 0) {
      // The forge took the cancel and no re-read showed the run stopped: give
      // the button back. It says the run is still going only if a re-read
      // actually saw that; otherwise it says it couldn't check.
      const runs: ActiveRun[] = [];
      for (const state of Object.values(runStates)) {
        if (state.phase !== "cancelling") continue;
        runs.push(state.run);
        runStates[state.run.runId] = {
          ...state,
          phase: "stalled",
          message: settleRead
            ? `${runsPhrase([state.run])} still running. The forge hasn't stopped it yet.`
            : `Couldn't check whether ${runLabel(state.run)} has stopped.`,
        };
      }
      speak(
        settleRead
          ? `${runsPhrase(runs)} still running. The forge hasn't stopped ${runs.length === 1 ? "it" : "them"} yet.`
          : `Couldn't check whether ${runsPhrase(runs, "or")} stopped.`,
      );
      return;
    }
    settleTimer = setTimeout(async () => {
      if (target !== row) return;
      if (await load(row, true)) settleRead = true;
      settle(row, left - 1);
    }, SETTLE_MS);
  }

  // A run the person cancelled that the checks no longer show going has
  // stopped. A run they were asked to confirm that finished on its own has
  // nothing left to cancel, so its question goes.
  // Returns what to say, so a read that also changed jobs speaks it once.
  function reconcileRuns(list: Check[]): string {
    const stopped: string[] = [];
    const finished: string[] = [];
    for (const state of Object.values(runStates)) {
      // Missing from the active runs isn't enough: a failed run lookup leaves
      // the same jobs going with no run id. The run's own jobs must be seen
      // finished.
      if (!runStopped(state.run, list)) continue;
      if (state.phase === "cancelling" || state.phase === "stalled") {
        runStates[state.run.runId] = { ...state, phase: "cancelled" };
        stopped.push(runLabel(state.run));
      } else if (state.phase === "confirm") {
        delete runStates[state.run.runId];
        finished.push(runLabel(state.run));
      }
    }
    const lines: string[] = [];
    if (stopped.length) {
      lines.push(
        `${joinLabels(stopped, "and")} ${stopped.length === 1 ? "was" : "were"} cancelled.`,
      );
    }
    if (finished.length) {
      lines.push(
        `${joinLabels(finished, "and")} ${finished.length === 1 ? "has" : "have"} finished.`,
      );
    }
    return lines.join(" ");
  }

  // "ci is", "ci and release are", "This run is", "2 runs are". Unnamed runs
  // are counted, since "this run and this run" says nothing. With a word the
  // list is closed by it and no verb follows ("ci or release").
  function runsPhrase(runs: ActiveRun[], word?: string): string {
    const named = runs.filter((r) => r.runName).map((r) => r.runName);
    const unnamed = runs.length - named.length;
    const parts = [...named];
    if (unnamed) {
      parts.push(
        named.length
          ? `${unnamed} other ${unnamed === 1 ? "run" : "runs"}`
          : unnamed === 1
            ? "this run"
            : `${unnamed} runs`,
      );
    }
    let text = joinLabels(parts, word ?? "and");
    if (word) return text;
    if (!named.length && unnamed === 1)
      text = text.charAt(0).toUpperCase() + text.slice(1);
    return `${text} ${runs.length === 1 ? "is" : "are"}`;
  }

  // "ci", "ci and release", "ci, release and deploy".
  function joinLabels(labels: string[], word = "and"): string {
    if (labels.length < 2) return labels[0] ?? "";
    return `${labels.slice(0, -1).join(", ")} ${word} ${labels[labels.length - 1]}`;
  }

  function askForExcerpts(list: Check[], url: string) {
    const picks = pickExcerptJobs(list, reads);
    if (!picks.length) return;
    const mine = excerptRun;
    void fillExcerpts(
      picks,
      url,
      (check, text) => {
        excerpts[excerptKey(check)] = text;
        speak(`Log excerpt loaded for ${check.name}.`);
      },
      fetch,
      () => mine !== excerptRun,
      undefined,
      reads,
    );
  }

  // One timer: redraw when the target's lock runs out. Moves rather than
  // stacks, and a lock left from an earlier dialog is picked up on open().
  function armLockTimer(cancel: { forge: string; fullName: string }) {
    clearTimeout(lockTimer);
    const lock = cancelLocks.get(cancelKey(cancel));
    if (!lock) return;
    const left = LOCK_MS - (Date.now() - lock.at);
    if (left < 0) return;
    lockTimer = setTimeout(() => lockTick++, left + 1);
  }

  export function open(next: PipelineTarget) {
    // Already open: showModal() would throw, and the dialog is modal, so only
    // a stray second call gets here.
    if (dialog.open) return;
    target = next;
    staleNote = "";
    excerptRun++;
    excerpts = {};
    reads = newExcerptReads();
    runStates = {};
    clearTimeout(settleTimer);
    clearTimeout(lockTimer);
    if (next.cancel) armLockTimer(next.cancel);
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

  // Draws the board's control again: what it reads outside the checks (the
  // forge's locks) changed.
  export function redrawControls() {
    controlsTick += 1;
  }

  // Resolves true when the read came back, whether or not anything changed.
  async function load(
    row: PipelineTarget,
    wantAgain = false,
  ): Promise<boolean> {
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
      // A read a newer one overtook still came back; only a failed one didn't.
      if (res.status === 401) {
        window.location.href = "/login.html";
        return false;
      }
      if (mine !== request) return res.ok;
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error || `backend answered ${res.status}`);
      }
      if (mine !== request) return true;
      const next: Check[] = body?.checks ?? [];
      if (again) {
        // Each check changes where it stands; nothing moves or redraws when no
        // check changed.
        const ordered = keepOrder(checks, next);
        staleNote = "";
        if (JSON.stringify(ordered) === JSON.stringify(checks)) return true;
        const line = announceChange(checks, ordered);
        const hadFocus = dialog
          .querySelector(".pipeline-dialog-body")
          ?.contains(document.activeElement);
        checks = ordered;
        const said = reconcileRuns(ordered);
        askForExcerpts(ordered, row.checksUrl);
        // One message per read: the announcer holds one at a time.
        const both = [said, line].filter(Boolean).join(" ");
        if (both) speak(both);
        // The control the keyboard was on is gone: its node went with it, so
        // focus goes to the close button instead of the page behind.
        if (hadFocus) {
          await tick();
          if (!dialog.contains(document.activeElement))
            dialog
              .querySelector<HTMLElement>(".pipeline-dialog-close")
              ?.focus({ preventScroll: true });
        }
        return true;
      }
      live?.refreshed();
      checks = blockingFirst(next);
      const said = reconcileRuns(checks);
      phase = "ready";
      if (said) speak(said);
      askForExcerpts(checks, row.checksUrl);
      return true;
    } catch (err) {
      if (mine !== request) return false;
      if (again) {
        live?.failed();
        staleNote = "Couldn't refresh these checks. They may be out of date.";
        return false;
      }
      message = `${row.errorText}: ${err instanceof Error ? err.message : String(err)}`;
      phase = "error";
      return false;
    }
  }

  // Fires for every way the dialog closes: Escape, the close button and a click
  // on the backdrop.
  function closed() {
    request++;
    excerptRun++;
    clearTimeout(settleTimer);
    clearTimeout(lockTimer);
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

  // Copy log is for a failed or timed-out check that has something to copy:
  // an excerpt, or a job whose full log the board's checks url can name. Only
  // those two states carry an excerpt from the server, and a cancelled run is
  // not a failure to debug (View run still opens its output).
  function copyableLog(check: Check): boolean {
    return canCopyLog(check, target?.checksUrl);
  }

  // The forge's name for a board that doesn't name it: the checks url carries
  // the forge.
  function forgeLabel(t: PipelineTarget): string {
    const forge = forgeOf(t.checksUrl);

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
    void controlsTick;
    // Untracked: the control reads the page's snapshot (its lock, its row) and
    // redraws itself when that changes, so a poll must not rebuild it.
    // The target itself stays tracked, so pointing the dialog at another row
    // draws that row's control.
    const isFailed = failed;
    const current = target;
    const node = untrack(() => current?.controls?.(isFailed)) ?? null;
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
      // A control with a button again gets the focus on it, not on its wrapper.
      const button = buttons()[0];
      if (button) button.focus({ preventScroll: true });
      else {
        node.tabIndex = -1;
        node.focus({ preventScroll: true });
      }
    }
  }
</script>

{#snippet list(items: Check[])}
  <ul class="pipeline-check-list">
    <!-- Keyed by name, and the nth of a shared name: two jobs can share a name
         with no page. -->
    {#each items as check (keyOf.get(check))}
      {@const copyable = copyableLog(check)}
      {@const forge = target ? forgeLabel(target) : "the forge"}
      {@const control = checkControl(check, target?.checksUrl)}
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
        {#if control === "output" && target && check.jobId}
          <CheckRunOutput
            name={check.name}
            jobId={check.jobId}
            checksUrl={target.checksUrl}
            runUrl={check.url}
            forgeName={forge}
          />
        {:else if control === "open-on-forge" || control === "link"}
          <!-- Never an empty href, which would resolve to this page. A job with
               no log to read yet (queued, or running on GitHub) links to the
               forge's own page. -->
          {@const linkText = checkLinkText(control, check.state, forge)}
          <a
            class="pipeline-check-link"
            href={check.url}
            target="_blank"
            rel="noopener"
            aria-label={checkLinkLabel(linkText, check.name)}>{linkText}</a
          >
        {/if}
        {#if check.failedStep}
          <p class="pipeline-check-step">Failed step: {check.failedStep}</p>
        {/if}
        <CopyCheckLog
          name={check.name}
          jobId={check.jobId}
          checksUrl={target?.checksUrl ?? ""}
          excerpt={check.excerpt ?? excerpts[excerptKey(check)] ?? ""}
          forgeName={forge}
          {copyable}
          runKey={checkRunKey(check)}
        />
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet cancelRow(run: ActiveRun, state: RunState | undefined)}
  <div class="pipeline-run-cancel" data-testid="cancel-run-{run.runId}">
    {#if state?.phase === "confirm"}
      <div
        class="pipeline-cancel-confirm"
        role="group"
        aria-label="Confirm cancelling {runLabel(run)}"
      >
        <p>
          Cancel the whole run <strong>{runLabel(run)}</strong>? It stops
          {run.jobs.length === 0
            ? "everything still going in it."
            : run.jobs.length === 1
              ? `its one unfinished job: ${run.jobs[0]}.`
              : `all ${run.jobs.length} of its unfinished jobs: ${run.jobs.join(", ")}.`}
          This can't be undone.
        </p>
        <button
          type="button"
          class="row-action confirm"
          data-cancel-confirm={run.runId}
          onclick={() => confirmCancel(run)}>Yes, cancel run</button
        >
        <button
          type="button"
          class="row-action"
          onclick={() => keepRunning(run)}>Keep running</button
        >
      </div>
    {:else if state?.phase === "cancelling"}
      <p class="pipeline-rerun-status" role="status">
        Cancelling {runLabel(run)}…
      </p>
    {:else if state?.phase === "stalled"}
      <p class="pipeline-rerun-status" role="status">
        {state.message}
      </p>
      <button
        type="button"
        class="row-action"
        data-cancel-run={run.runId}
        onclick={() => startCancel(run)}>{cancelText(run)}</button
      >
    {:else if state?.phase === "cancelled"}
      <p class="pipeline-rerun-status" role="status">
        {runLabel(run)} was cancelled.
      </p>
    {:else if state?.phase === "refused"}
      <p class="pipeline-cancel-refused" role="alert">
        Couldn't cancel {runLabel(run)}: {state.message}
      </p>
    {:else if cancelLock}
      <p class="pipeline-rerun-status">
        {cancelText(run)} isn't available. {cancelLock}
      </p>
    {:else}
      <button
        type="button"
        class="row-action"
        data-cancel-run={run.runId}
        onclick={() => startCancel(run)}>{cancelText(run)}</button
      >
    {/if}
  </div>
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
      {#if runEntries.length}
        <div class="pipeline-runs">
          {#each runEntries as { run, state } (run.runId)}
            {@render cancelRow(run, state)}
          {/each}
        </div>
      {/if}
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
  .pipeline-runs {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
  }
  .pipeline-cancel-confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .pipeline-cancel-confirm p,
  .pipeline-cancel-refused {
    margin: 0;
    flex-basis: 100%;
    font-size: 12.5px;
  }
  .pipeline-cancel-refused {
    color: var(--critical);
  }
</style>

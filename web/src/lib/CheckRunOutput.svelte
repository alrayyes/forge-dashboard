<script lang="ts">
  // One check's "Show output": a button that opens the job's output under the
  // check, with a Copy button beside it, and a link to the job on the forge for
  // when the output is cut or can't be read. Text only: the output is never
  // parsed as markup. Each line's number is a button that copies that line
  // (#4280): one tab stop for the whole log, the arrow keys move between lines.
  // Expand opens the same log in a wide modal dialog (#4281). The panel stays
  // drawn behind it, so it keeps its width and scroll position, and the
  // switches are the one setting for both.
  import { onDestroy, tick, type Snippet } from "svelte";
  import ExternalLinkIcon from "#lib/ExternalLinkIcon.svelte";
  import type { Check } from "#lib/pipeline-checks.js";
  import { CopyFlow, selectCopy } from "#lib/copy-flow.svelte.js";
  import {
    checkLinkLabel,
    copyLineLabel,
    copyLineStatus,
    copyLog,
    lineCopyText,
    loadRunLog,
    logUrl,
    notePlaces,
    outputToggleLabel,
    outputToggleName,
    parseLogLines,
    type RepoRef,
    rovingLine,
  } from "#lib/run-log.js";

  let {
    name,
    jobId = undefined,
    repo,
    run,
    runUrl,
    forgeName,
    onloaded,
    earlier,
    excerpt = "",
    context,
  }: {
    name: string;
    // None for a check with no job to read: the view then shows only its
    // excerpt, with no toggle or buttons.
    jobId?: number;
    repo: RepoRef | undefined;
    // The job's attempt and finish time, which let the server keep a finished
    // log and read a rerun afresh.
    run?: Pick<Check, "runAttempt" | "completedAt">;
    runUrl: string;
    forgeName: string;
    // Told when the panel is open with its text loaded, and when it stops
    // being: the row hides its excerpt and second Copy button meanwhile.
    onloaded?: (loaded: boolean) => void;
    // The excerpt's copy flow. Its button leaves when this panel loads, so a
    // copy pressed meanwhile reports here instead of into nothing (#3343).
    earlier?: CopyFlow;
    // A failed check's log excerpt. It is drawn by this same view until the
    // full output is loaded, which then takes its place (#4652). Closed, the
    // toggle says it opens the full output (#4236).
    excerpt?: string;
    // The row's hint and failed step. They are drawn between the buttons and
    // the log, so the page reads in the order the eye does.
    context?: Snippet;
  } = $props();

  const url = $derived(jobId !== undefined ? logUrl(repo, jobId, run) : null);
  let shown = $state(false);
  let phase = $state<"loading" | "ready" | "error">("loading");
  // The view holds the full log once it is open and loaded, else the excerpt.
  const full = $derived(shown && phase === "ready");
  const excerptVisible = $derived(!!excerpt && !full);
  const toggleLabel = $derived(outputToggleLabel(shown, excerptVisible));
  const toggleName = $derived(outputToggleName(shown, excerptVisible));
  let text = $state("");
  const lines = $derived(parseLogLines(full ? text : excerpt));
  let truncated = $state(false);
  let message = $state("");
  // Whether the failure gets a link to the job beside its sentence.
  let linkable = $state(false);
  // A late answer for a closed panel is dropped. The one polite line, for the
  // load and for a copy alike, is the flow's.
  const flow = new CopyFlow(() => forgeName, "output");
  // This panel's own line wins; the excerpt's copy fills in when it has none.
  const statusLine = $derived(
    flow.busy
      ? "Copying"
      : flow.status || (earlier?.busy ? "Copying" : (earlier?.status ?? "")),
  );
  // The line whose button is the log's one tab stop, the line just copied, and
  // the sentence for the toast and the live region. All three are one number or
  // string, so a 5000-line log keeps no per-line state.
  let active = $state(0);
  // A shorter log loaded after a late line had focus must still have a stop.
  const stop = $derived(Math.min(active, Math.max(lines.length - 1, 0)));
  let copiedLine = $state(-1);
  let lineStatus = $state("");
  // The toast's fade, apart from its words, so a repeat copy doesn't blink it.
  let toastOn = $state(false);
  let lineTimer: ReturnType<typeof setTimeout> | undefined;
  // Timestamps start off on a phone, where they take a third of a line.
  let timestamps = $state(
    typeof window === "undefined" ||
      !window.matchMedia("(max-width: 600px)").matches,
  );
  // Lines wrap by default; off, a long line scrolls the one log area sideways.
  let wrap = $state(true);
  const hasTimes = $derived(lines.some((l) => l.time));
  onDestroy(() => {
    clearTimeout(lineTimer);
    flow.destroy();
    onloaded?.(false);
  });
  let panel = $state<HTMLDivElement>();
  let toggleButton = $state<HTMLButtonElement>();
  let ask = 0;
  // The wide dialog is always in the markup, closed; its contents are drawn
  // only while it is open, so a long log is not kept in the page twice.
  let wideOpen = $state(false);
  let wideDialog = $state<HTMLDialogElement>();
  let output = $state<HTMLDivElement>();
  let wideOutput = $state<HTMLDivElement>();
  let panelCopy = $state<HTMLButtonElement>();
  let wideCopy = $state<HTMLButtonElement>();
  let expandButton = $state<HTMLButtonElement>();
  // A selection copy runs inside the open modal: the page behind it is inert.
  $effect(() => {
    flow.button = wideOpen ? wideCopy : panelCopy;
  });
  const panelId = `run-output-${Math.random().toString(36).slice(2, 9)}`;

  function endLineCopy() {
    clearTimeout(lineTimer);
    copiedLine = -1;
    lineStatus = "";
    toastOn = false;
  }

  async function copyLine(i: number, button: HTMLButtonElement) {
    const n = i + 1;
    const text = lineCopyText(lines[i]);
    // The hide timer runs from the press, so a write that hangs behind a
    // permission prompt can't leave an old toast up. The toast keeps its words
    // until the write lands: it is never an empty pill.
    clearTimeout(lineTimer);
    lineTimer = setTimeout(endLineCopy, 2000);
    // An empty line has nothing to put on the clipboard: say so, claim no copy.
    const outcome = text
      ? await copyLog(text, {
          clipboard: navigator.clipboard,
          select: () =>
            selectCopy(text, button.closest("dialog") ?? document.body),
        })
      : "nothing";
    // The same words again are no change to a live region, so a trailing
    // no-break space flips each time they repeat. The toast keeps its words,
    // and never shows empty.
    const base = copyLineStatus(n, outcome);
    const said = lineStatus === base ? `${base}\u00a0` : base;
    copiedLine = outcome === "copied" ? i : -1;
    lineStatus = said;
    toastOn = true;
    clearTimeout(lineTimer);
    lineTimer = setTimeout(endLineCopy, 2000);
  }

  async function moveLine(e: KeyboardEvent, i: number) {
    const next = rovingLine(i, e.key, lines.length);
    if (next === null) return;
    e.preventDefault();
    active = next;
    // The event's target is gone once the tick has passed.
    const log = (e.currentTarget as HTMLElement).closest(".run-output-text");
    await tick();
    log?.querySelector<HTMLButtonElement>(`[data-line="${next}"]`)?.focus();
  }

  async function expand() {
    wideOpen = true;
    await tick();
    wideDialog?.showModal();
    // The end of a log is where it failed, here as in the panel.
    if (wideOutput) wideOutput.scrollTop = wideOutput.scrollHeight;
  }

  // Fires for every way the dialog closes: Escape, either Close and a click on
  // the backdrop. Focus goes back to the button that opened it.
  function wideClosed() {
    wideOpen = false;
    endLineCopy();
    expandButton?.focus();
  }

  // A modal dialog lets Tab walk out of its last control to the browser's own
  // chrome. Keep the walk in a ring: past the last control is the first, and
  // back from the first is the last.
  function wideKeys(event: KeyboardEvent) {
    if (event.key !== "Tab" || !wideDialog) return;
    const stops = [
      ...wideDialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
      ),
    ].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const at = document.activeElement;
    if (event.shiftKey && at === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && at === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // The backdrop is the dialog element itself, but so are the margins around
  // the log. A click is outside only when it started and ended past the
  // dialog's box, so a click in a gutter, or a selection drag released there,
  // keeps it open.
  let pressedOutside = false;
  function outsideBox(event: MouseEvent) {
    if (event.target !== wideDialog || !wideDialog) return false;
    const r = wideDialog.getBoundingClientRect();
    return (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    );
  }
  function wideDown(event: MouseEvent) {
    pressedOutside = outsideBox(event);
  }
  function wideOutside(event: MouseEvent) {
    const started = pressedOutside;
    pressedOutside = false;
    if (started && outsideBox(event)) wideDialog?.close();
  }

  async function toggle() {
    shown = !shown;
    flow.reset();
    endLineCopy();
    // What the excerpt's copy said was heard once; hiding the panel ends it, so
    // showing the panel again doesn't announce it as new (#3360). Only the line
    // goes: the field to copy from stays, and a copy still running keeps going
    // (#3424).
    if (!shown) earlier?.clearStatus();
    if (!shown || !url) {
      ask++;
      onloaded?.(false);
      return;
    }
    const mine = ++ask;
    phase = "loading";
    onloaded?.(false);
    flow.status = "Loading output";
    const got = await loadRunLog(url, forgeName);
    if (mine !== ask) return;
    if (got.ok) {
      // The excerpt's Copy button leaves when the text lands. If it had focus,
      // the panel's Copy button takes it.
      const copyArea = panel
        ?.closest("li")
        ?.querySelector(".pipeline-check-copy");
      const hadFocus = !!copyArea?.contains(document.activeElement);
      // The excerpt's own controls go when the full log lands: focus moves to
      // the toggle, which stays, so it isn't dropped to the page.
      const inExcerpt = !!panel
        ?.closest("li")
        ?.querySelector(".run-excerpt")
        ?.contains(document.activeElement);
      text = got.text;
      truncated = got.truncated;
      phase = "ready";
      flow.status = "";
      onloaded?.(true);
      // The end of a log is where it failed.
      await tick();
      if (hadFocus) flow.button?.focus();
      else if (inExcerpt) toggleButton?.focus();
      if (output) output.scrollTop = output.scrollHeight;
    } else {
      message = got.message;
      linkable = got.kind !== "other";
      phase = "error";
      flow.status = "";
    }
  }

  function copy() {
    return flow.copy(() =>
      Promise.resolve(
        excerptVisible
          ? { text: excerpt, kind: "excerpt" as const, why: "" }
          : {
              text,
              kind: truncated ? ("cut" as const) : ("whole" as const),
              why: "",
            },
      ),
    );
  }
</script>

{#snippet switches()}
  {#if hasTimes}
    <label class="run-log-switch">
      <input type="checkbox" bind:checked={timestamps} />Timestamps
    </label>
  {/if}
  <label class="run-log-switch">
    <input type="checkbox" bind:checked={wrap} />Wrap lines
  </label>
{/snippet}
{#snippet logView(wide: boolean)}
  <!-- The line buttons are focusable, so the scroll region is reachable
       from the keyboard without a tab stop of its own. -->
  <div class="run-log">
    <div
      class="run-output-text"
      class:run-output-stamped={timestamps && hasTimes}
      class:run-output-nowrap={!wrap}
      {@attach (el) => {
        if (wide) wideOutput = el as HTMLDivElement;
        else output = el as HTMLDivElement;
      }}
      role="region"
      aria-label={excerptVisible
        ? `Output excerpt: ${name}`
        : `Output: ${name}`}
    >
      {#if lines.length}
        {#each lines as line, i (i)}
          <div
            class="run-line run-line-{line.kind}"
            class:run-line-copied={copiedLine === i}
          >
            <button
              type="button"
              class="run-line-no"
              data-line={i}
              tabindex={i === stop ? 0 : -1}
              aria-label={copyLineLabel(i + 1)}
              onclick={(e) => copyLine(i, e.currentTarget)}
              onfocus={() => (active = i)}
              onkeydown={(e) => moveLine(e, i)}
              >{#if copiedLine === i}<svg
                  class="run-line-check"
                  viewBox="0 0 16 16"
                  width="11"
                  height="11"
                  aria-hidden="true"
                  focusable="false"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"><path d="M3 8.5l3.5 3.5L13 5" /></svg
                >{/if}{i + 1}</button
            >{#if timestamps && line.time}<span class="run-line-time"
                >{line.time}</span
              >{/if}<span class="run-line-text"
              >{#if line.kind === "error"}<span class="run-line-tag">Error</span
                >{:else if line.kind === "warning"}<span class="run-line-tag"
                  >Warning</span
                >{/if}{line.text}</span
            >
          </div>
        {/each}
      {:else}
        <p class="run-output-empty">This job wrote no output.</p>
      {/if}
    </div>
    <p
      class="run-line-toast"
      class:run-line-toast-on={toastOn}
      role={wide || !wideOpen ? "status" : undefined}
      aria-live={wide || !wideOpen ? "polite" : undefined}
    >
      {lineStatus}
    </p>
  </div>
{/snippet}
{#snippet logBar()}
  <div class="run-log-bar">
    {@render switches()}
    <button
      bind:this={expandButton}
      type="button"
      class="run-expand"
      aria-label="Expand log: {name}"
      aria-haspopup="dialog"
      onclick={expand}>Expand</button
    >
  </div>
{/snippet}
{#snippet jobLink(label: string)}
  <a
    href={runUrl}
    target="_blank"
    rel="noopener"
    aria-label={checkLinkLabel(label, name)}>{label}<ExternalLinkIcon /></a
  >
{/snippet}
{#if jobId !== undefined}
  <div class="run-actions">
    <button
      bind:this={toggleButton}
      type="button"
      class="run-toggle"
      aria-expanded={shown}
      aria-controls={panelId}
      disabled={!url}
      onclick={toggle}
      aria-label="{toggleName}: {name}"
      >{toggleLabel}<svg
        class="run-chevron"
        viewBox="0 0 16 16"
        width="12"
        height="12"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><path d={shown ? "M3 10l5-5 5 5" : "M3 6l5 5 5-5"} /></svg
      ></button
    >
    <!-- The slot is always there, so the toggle and the job link don't move when
       the output loads (#3866). Until the text is ready it is out of sight and
       out of the tab order. -->
    {#if url}
      <button
        bind:this={panelCopy}
        type="button"
        class="run-icon-btn"
        class:run-icon-btn-idle={!(shown && phase === "ready")}
        aria-disabled={flow.busy ? "true" : undefined}
        aria-busy={flow.busy ? "true" : undefined}
        onclick={copy}
        title="Copy output"
        aria-label="Copy output: {name}"
        ><svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          ><rect x="5" y="5" width="9" height="9" rx="1.5" /><path
            d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"
          /></svg
        ></button
      >
    {/if}
    <a
      class="run-icon-btn"
      href={runUrl}
      target="_blank"
      rel="noopener"
      title="Open job on {forgeName}"
      aria-label={checkLinkLabel(`Open job on ${forgeName}`, name)}
      ><ExternalLinkIcon /></a
    >
  </div>
{/if}
{@render context?.()}
<div id={panelId} class="run-output" hidden={!shown} bind:this={panel}>
  {#if shown}
    <!-- While the wide dialog is open its own line is the one that speaks. -->
    <p class="run-output-status" aria-live={wideOpen ? "off" : "polite"}>
      {statusLine}
    </p>
    {#if phase === "error"}
      <p class="run-output-error">
        {message}
        {#if linkable}{@render jobLink("Open job on " + forgeName)}{/if}
      </p>
    {:else if phase === "ready"}
      {#if truncated}
        <p class="run-output-note">
          {notePlaces()}
          {@render jobLink("Open job on " + forgeName + " for the rest")}
        </p>
      {/if}
      {@render logBar()}
      {@render logView(false)}
    {/if}
    {#if flow.manual && !wideOpen}
      <textarea
        bind:this={flow.field}
        class="pipeline-check-manual"
        readonly
        rows="6"
        aria-label="Output to copy: {name}">{flow.manual}</textarea
      >
    {/if}
  {/if}
</div>
{#if excerptVisible}
  <!-- Until the full output is open and loaded, the excerpt is the log. -->
  <div class="run-excerpt">
    {@render logBar()}
    {@render logView(false)}
  </div>
{/if}
<!-- The wide log (#4281). One scroll area, the log; Close and the run link sit
     under it, out of the scroll. -->
<dialog
  bind:this={wideDialog}
  class="run-wide-dialog"
  aria-label="Log: {name}"
  onclose={wideClosed}
  onmousedown={wideDown}
  onclick={wideOutside}
  onkeydown={wideKeys}
>
  {#if wideOpen}
    <div class="run-wide-head">
      <h2 class="run-wide-title">{name}</h2>
      <button
        type="button"
        class="run-wide-x"
        aria-label="Close log dialog"
        onclick={() => wideDialog?.close()}
        ><svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          ><path d="M18 6 6 18" /><path d="M6 6l12 12" /></svg
        ></button
      >
    </div>
    <div class="run-wide-bar">
      <div class="run-log-bar">{@render switches()}</div>
      <button
        bind:this={wideCopy}
        type="button"
        class="run-wide-btn"
        aria-disabled={flow.busy ? "true" : undefined}
        aria-busy={flow.busy ? "true" : undefined}
        onclick={copy}>Copy log</button
      >
    </div>
    <p class="run-output-status run-wide-status" aria-live="polite">
      {statusLine}
    </p>
    {#if truncated}
      <p class="run-output-note run-wide-note">
        {notePlaces()}
        {@render jobLink("Open job on " + forgeName + " for the rest")}
      </p>
    {/if}
    {@render logView(true)}
    {#if flow.manual}
      <textarea
        bind:this={flow.field}
        class="pipeline-check-manual run-wide-manual"
        readonly
        rows="6"
        aria-label="Output to copy: {name}">{flow.manual}</textarea
      >
    {/if}
    <div class="run-wide-foot">
      <button
        type="button"
        class="run-wide-btn"
        onclick={() => wideDialog?.close()}>Close</button
      >
      <a
        class="run-wide-btn run-wide-primary"
        href={runUrl}
        target="_blank"
        rel="noopener"
        aria-label={checkLinkLabel(`Open run on ${forgeName}`, name)}
        >Open run on {forgeName}<ExternalLinkIcon /></a
      >
    </div>
  {/if}
</dialog>

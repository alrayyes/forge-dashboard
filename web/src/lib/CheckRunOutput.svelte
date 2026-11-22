<script lang="ts">
  // One check's "Show output": a button that opens the job's output under the
  // check, with a Copy button beside it, and a link to the job on the forge for
  // when the output is cut or can't be read. Text only: the output is never
  // parsed as markup. Each line's number is a button that copies that line
  // (#4280): one tab stop for the whole log, the arrow keys move between lines.
  import { onDestroy, tick } from "svelte";
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
    jobId,
    repo,
    run,
    runUrl,
    forgeName,
    onloaded,
    earlier,
    excerptVisible = false,
  }: {
    name: string;
    jobId: number;
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
    // Whether the row is showing a failure excerpt. Closed, the toggle then
    // says it opens the full output (#4236).
    excerptVisible?: boolean;
  } = $props();

  const url = $derived(logUrl(repo, jobId, run));
  let shown = $state(false);
  const toggleLabel = $derived(outputToggleLabel(shown, excerptVisible));
  const toggleName = $derived(outputToggleName(shown, excerptVisible));
  let phase = $state<"loading" | "ready" | "error">("loading");
  let text = $state("");
  const lines = $derived(parseLogLines(text));
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
  const hasTimes = $derived(lines.some((l) => l.time));
  onDestroy(() => {
    clearTimeout(lineTimer);
    flow.destroy();
    onloaded?.(false);
  });
  let panel = $state<HTMLDivElement>();
  let ask = 0;
  let output = $state<HTMLDivElement>();
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
    clearTimeout(lineTimer);
    // An empty line has nothing to put on the clipboard, and nothing to say.
    if (!text) {
      endLineCopy();
      return;
    }
    // Clear first, so a repeat copy of the same line is a change the live
    // region announces again while the clipboard write is in flight.
    lineStatus = "";
    const outcome = await copyLog(text, {
      clipboard: navigator.clipboard,
      select: () => selectCopy(text, button.closest("dialog") ?? document.body),
    });
    // The check and the toast go together after about two seconds.
    copiedLine = outcome === "copied" ? i : -1;
    lineStatus = copyLineStatus(n, outcome);
    toastOn = true;
    lineTimer = setTimeout(endLineCopy, 2000);
  }

  async function moveLine(e: KeyboardEvent, i: number) {
    const next = rovingLine(i, e.key, lines.length);
    if (next === null) return;
    e.preventDefault();
    active = next;
    await tick();
    output?.querySelector<HTMLButtonElement>(`[data-line="${next}"]`)?.focus();
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
      text = got.text;
      truncated = got.truncated;
      phase = "ready";
      flow.status = "";
      onloaded?.(true);
      // The end of a log is where it failed.
      await tick();
      if (hadFocus) flow.button?.focus();
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
      Promise.resolve({
        text,
        kind: truncated ? ("cut" as const) : ("whole" as const),
        why: "",
      }),
    );
  }
</script>

{#snippet jobLink(label: string)}
  <a
    href={runUrl}
    target="_blank"
    rel="noopener"
    aria-label={checkLinkLabel(label, name)}>{label}<ExternalLinkIcon /></a
  >
{/snippet}
<div class="run-actions">
  <button
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
      bind:this={flow.button}
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
<div id={panelId} class="run-output" hidden={!shown} bind:this={panel}>
  {#if shown}
    <p class="run-output-status" aria-live="polite">
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
      {#if hasTimes}
        <label class="run-log-switch">
          <input type="checkbox" bind:checked={timestamps} />Timestamps
        </label>
      {/if}
      <!-- The line buttons are focusable, so the scroll region is reachable
           from the keyboard without a tab stop of its own. -->
      <div class="run-log">
        <div
          class="run-output-text"
          class:run-output-stamped={timestamps && hasTimes}
          bind:this={output}
          role="region"
          aria-label="Output: {name}"
        >
          {#if text}
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
                      stroke-linejoin="round"
                      ><path d="M3 8.5l3.5 3.5L13 5" /></svg
                    >{/if}{i + 1}</button
                >{#if timestamps && line.time}<span class="run-line-time"
                    >{line.time}</span
                  >{/if}<span class="run-line-text"
                  >{#if line.kind === "error"}<span class="run-line-tag"
                      >Error</span
                    >{:else if line.kind === "warning"}<span
                      class="run-line-tag">Warning</span
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
          role="status"
          aria-live="polite"
        >
          {lineStatus}
        </p>
      </div>
    {/if}
    {#if flow.manual}
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

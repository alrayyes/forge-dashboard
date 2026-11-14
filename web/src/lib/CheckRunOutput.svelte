<script lang="ts">
  // One check's "Show output": a button that opens the job's output under the
  // check, with a Copy button beside it, and a link to the job on the forge for
  // when the output is cut or can't be read. Text only: the output is never
  // parsed as markup.
  import { onDestroy, tick } from "svelte";
  import ExternalLinkIcon from "#lib/ExternalLinkIcon.svelte";
  import { CopyFlow } from "#lib/copy-flow.svelte.js";
  import {
    checkLinkLabel,
    loadRunLog,
    logUrl,
    notePlaces,
    parseLogLines,
    type RepoRef,
  } from "#lib/run-log.js";

  let {
    name,
    jobId,
    repo,
    runUrl,
    forgeName,
    onloaded,
    earlier,
  }: {
    name: string;
    jobId: number;
    repo: RepoRef | undefined;
    runUrl: string;
    forgeName: string;
    // Told when the panel is open with its text loaded, and when it stops
    // being: the row hides its excerpt and second Copy button meanwhile.
    onloaded?: (loaded: boolean) => void;
    // The excerpt's copy flow. Its button leaves when this panel loads, so a
    // copy pressed meanwhile reports here instead of into nothing (#3343).
    earlier?: CopyFlow;
  } = $props();

  const url = $derived(logUrl(repo, jobId));
  let shown = $state(false);
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
  onDestroy(() => {
    flow.destroy();
    onloaded?.(false);
  });
  let panel = $state<HTMLDivElement>();
  let ask = 0;
  let output = $state<HTMLPreElement>();
  const panelId = `run-output-${Math.random().toString(36).slice(2, 9)}`;

  async function toggle() {
    shown = !shown;
    flow.reset();
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
    aria-label="{shown ? 'Hide output' : 'Show output'}: {name}"
    >{shown ? "Hide output" : "Show output"}<svg
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
      <!-- It scrolls, so it takes focus to be reachable from the keyboard. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre
        class="run-output-text"
        bind:this={output}
        tabindex="0"
        role="region"
        aria-label="Output: {name}">{#if text}{#each lines as line}<span
              class="run-line run-line-{line.kind}"
              >{#if line.time}<span class="run-line-time">{line.time}</span
                >{/if}{#if line.kind === "error"}<span class="run-line-tag"
                  >Error</span
                >{:else if line.kind === "warning"}<span class="run-line-tag"
                  >Warning</span
                >{/if}<span class="run-line-text">{line.text}</span></span
            >{/each}{:else}This job wrote no output.{/if}</pre>
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

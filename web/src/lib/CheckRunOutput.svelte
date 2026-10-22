<script lang="ts">
  // One check's "View run": a button that opens the job's output under the
  // check, with a Copy button beside it, and a link to the run on the forge for
  // when the output is cut or can't be read. Text only: the output is never
  // parsed as markup.
  import { onDestroy, tick } from "svelte";
  import { CopyFlow } from "#lib/copy-flow.svelte.js";
  import { loadRunLog, logUrl, notePlaces } from "#lib/run-log.js";

  let {
    name,
    jobId,
    checksUrl,
    runUrl,
    forgeName,
  }: {
    name: string;
    jobId: number;
    checksUrl: string;
    runUrl: string;
    forgeName: string;
  } = $props();

  const url = $derived(logUrl(checksUrl, jobId));
  let shown = $state(false);
  let phase = $state<"loading" | "ready" | "error">("loading");
  let text = $state("");
  let truncated = $state(false);
  let message = $state("");
  // The polite line while the output loads, and a late answer for a closed
  // panel is dropped. A copy's own line comes from the shared flow.
  let status = $state("");
  const flow = new CopyFlow(() => forgeName);
  onDestroy(() => flow.destroy());
  let ask = 0;
  let output = $state<HTMLPreElement>();
  const panelId = `run-output-${Math.random().toString(36).slice(2, 9)}`;

  async function toggle() {
    shown = !shown;
    status = "";
    flow.reset();
    if (!shown || !url) {
      ask++;
      return;
    }
    const mine = ++ask;
    phase = "loading";
    status = "Loading output";
    const got = await loadRunLog(url, forgeName);
    if (mine !== ask) return;
    if (got.ok) {
      text = got.text;
      truncated = got.truncated;
      phase = "ready";
      status = "";
      // The end of a log is where it failed.
      await tick();
      if (output) output.scrollTop = output.scrollHeight;
    } else {
      message = got.message;
      phase = "error";
      status = "";
    }
  }

  function copy() {
    return flow.copy(async (guard) => {
      guard();

      return { text, kind: truncated ? "cut" : "whole", why: "" };
    });
  }
</script>

<button
  type="button"
  class="pipeline-check-link"
  aria-expanded={shown}
  aria-controls={panelId}
  disabled={!url}
  onclick={toggle}
  aria-label="{shown ? 'Hide run' : 'View run'}: {name}"
  >{shown ? "Hide run" : "View run"}</button
>
<a
  class="pipeline-check-link"
  href={runUrl}
  target="_blank"
  rel="noopener"
  aria-label="Open on {forgeName} (opens in a new tab): {name}"
  >Open on {forgeName}</a
>
<div id={panelId} class="run-output" hidden={!shown}>
  {#if shown}
    <div class="run-output-bar">
      <span class="run-output-title">Output</span>
      <button
        bind:this={flow.button}
        type="button"
        class="pipeline-check-link"
        disabled={phase !== "ready"}
        onclick={copy}
        aria-label="Copy output: {name}">Copy</button
      >
    </div>
    <p class="run-output-status" aria-live="polite">
      {flow.busy ? "Copying" : flow.status || status}
    </p>
    {#if phase === "error"}
      <p class="run-output-error">{message}</p>
    {:else if phase === "ready"}
      {#if truncated}
        <p class="run-output-note">{notePlaces(forgeName)}</p>
      {/if}
      <!-- It scrolls, so it takes focus to be reachable from the keyboard. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre
        class="run-output-text"
        bind:this={output}
        tabindex="0"
        role="region"
        aria-label="Output: {name}">{text || "This job wrote no output."}</pre>
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

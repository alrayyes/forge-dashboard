<script lang="ts">
  // One check's "View run": a button that opens the job's output under the
  // check, with a Copy button beside it, and a link to the run on the forge for
  // when the output is cut or can't be read. Text only: the output is never
  // parsed as markup.
  import { tick } from "svelte";
  import { copyLog, loadRunLog, logUrl, notePlaces } from "#lib/run-log.js";

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
  // The polite line a copy earns, and a late answer for a closed panel is dropped.
  let status = $state("");
  let ask = 0;
  let output = $state<HTMLPreElement>();
  const panelId = `run-output-${Math.random().toString(36).slice(2, 9)}`;

  async function toggle() {
    shown = !shown;
    status = "";
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

  async function copy() {
    const result = await copyLog(text, {
      clipboard: navigator.clipboard,
      select() {
        if (!output) return false;
        const range = document.createRange();
        range.selectNodeContents(output);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        try {
          return document.execCommand("copy");
        } catch {
          return false;
        }
      },
    });
    status =
      result === "copied"
        ? "Copied"
        : "Couldn't copy automatically. The output is selected: press Ctrl+C.";
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
        type="button"
        class="pipeline-check-link"
        disabled={phase !== "ready"}
        onclick={copy}
        aria-label="Copy output: {name}">Copy</button
      >
    </div>
    <p class="run-output-status" aria-live="polite">{status}</p>
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
  {/if}
</div>

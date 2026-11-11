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
    // showing the panel again doesn't announce it as new (#3360). A copy still
    // running keeps going.
    if (!shown && earlier && !earlier.busy) earlier.reset();
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
    aria-label={checkLinkLabel(label, name)}>{label}</a
  >
{/snippet}
<button
  type="button"
  class="pipeline-check-link"
  aria-expanded={shown}
  aria-controls={panelId}
  disabled={!url}
  onclick={toggle}
  aria-label="{shown ? 'Hide output' : 'Show output'}: {name}"
  >{shown ? "Hide output" : "Show output"}</button
>
<a
  class="pipeline-check-link"
  href={runUrl}
  target="_blank"
  rel="noopener"
  aria-label={checkLinkLabel(`Open job on ${forgeName}`, name)}
  >Open job on {forgeName}<ExternalLinkIcon /></a
>
<div id={panelId} class="run-output" hidden={!shown} bind:this={panel}>
  {#if shown}
    <div class="run-output-bar">
      <span class="run-output-title">Output</span>
      {#if phase === "ready"}
        <button
          bind:this={flow.button}
          type="button"
          class="pipeline-check-link"
          aria-disabled={flow.busy ? "true" : undefined}
          aria-busy={flow.busy ? "true" : undefined}
          onclick={copy}
          aria-label="Copy output: {name}">Copy</button
        >
      {/if}
    </div>
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

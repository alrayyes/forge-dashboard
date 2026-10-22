<script lang="ts">
  // A failed check's log excerpt with its Copy log button. One click copies the
  // whole log from the log endpoint, or the excerpt when the whole log can't be
  // read, and the status says which landed. Text only: nothing here is parsed
  // as markup.
  import { onDestroy } from "svelte";
  import { CopyFlow } from "#lib/copy-flow.svelte.js";
  import {
    COPIED_LOG_KEPT_MS,
    logSource,
    logToCopy,
    type Prepared,
  } from "#lib/run-log.js";

  let {
    name,
    jobId,
    checksUrl,
    excerpt,
    forgeName,
    copyable,
    runKey,
  }: {
    name: string;
    jobId?: number;
    checksUrl: string;
    excerpt: string;
    forgeName: string;
    // Only a failed check with something to copy shows the button.
    copyable: boolean;
    // What tells one run of the job from another when the forge reuses the job
    // id for a rerun.
    runKey: string;
  } = $props();

  const flow = new CopyFlow(() => forgeName);

  // The row is keyed by the check's name, so a rerun hands the same component a
  // new job. What was copied or shown for the old one must not stay for the
  // new one: someone could paste a stale log into a ticket. The job and its
  // run name the log; a check with no job copies its excerpt, so that names it
  // instead. A check with nothing to copy has no log at all, which drops the
  // field with the button. A later excerpt of the same run is the same log and
  // changes nothing.
  let identity: string | undefined;
  // The log read for the current identity, so pressing again doesn't download
  // it twice, for a minute: a read just after the job finished may have missed
  // lines still being flushed. A whole or cut log only: an excerpt stands for
  // a failed read.
  let cached: { prepared: Prepared; at: number } | undefined;
  $effect.pre(() => {
    const next = !copyable
      ? "none"
      : jobId
        ? `job:${jobId}:${runKey}`
        : `excerpt:${excerpt}`;
    if (identity !== undefined && next !== identity) {
      cached = undefined;
      flow.reset();
    }
    identity = next;
  });

  onDestroy(() => flow.destroy());

  function copy() {
    return flow.copy((guard) => {
      // The clipboard write starts here, inside the click, with the log still
      // being read.
      const source = logSource(checksUrl, jobId);
      const kept =
        cached && Date.now() - cached.at < COPIED_LOG_KEPT_MS
          ? cached.prepared
          : undefined;
      return (
        kept
          ? Promise.resolve(kept)
          : logToCopy(source.url, excerpt, forgeName, fetch, source.why)
      ).then((prepared) => {
        // A check rerun (or its row gone) while the log loads has another log
        // now: the read fails then, so nothing is written.
        guard();
        if (prepared.kind !== "excerpt") cached = { prepared, at: Date.now() };

        return prepared;
      });
    });
  }
</script>

{#if excerpt}
  <!-- It scrolls, so it takes focus to be reachable from the keyboard. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <pre
    class="pipeline-check-excerpt"
    tabindex="0"
    aria-label="Log excerpt: {name}">{excerpt}</pre>
{/if}
{#if copyable}
  <div class="pipeline-check-copy">
    <button
      bind:this={flow.button}
      type="button"
      class="pipeline-check-link"
      aria-disabled={flow.busy ? "true" : undefined}
      aria-busy={flow.busy ? "true" : undefined}
      onclick={copy}
      aria-label="Copy log: {name}">Copy log</button
    >
    <span class="pipeline-check-copy-status" role="status"
      >{flow.busy ? "Copying" : flow.status}</span
    >
  </div>
{/if}
{#if flow.manual}
  <textarea
    bind:this={flow.field}
    class="pipeline-check-manual"
    readonly
    rows="6"
    aria-label="Log to copy: {name}">{flow.manual}</textarea
  >
{/if}

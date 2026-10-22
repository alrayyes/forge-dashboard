<script lang="ts">
  // The Copy log button of a failed check, drawn beside its excerpt. One click
  // copies the whole log from the log endpoint, or the excerpt when the whole
  // log can't be read. Text only: nothing here is parsed as markup.
  import { copyLog, logToCopy, logUrl } from "#lib/run-log.js";

  let {
    name,
    jobId,
    checksUrl,
    excerpt,
    forgeName,
  }: {
    name: string;
    jobId?: number;
    checksUrl: string;
    excerpt: string;
    forgeName: string;
  } = $props();

  let status = $state("");
  let busy = $state(false);
  let button = $state<HTMLButtonElement>();

  async function copy() {
    if (busy) return;
    busy = true;
    status = "Copying";
    const url = jobId ? logUrl(checksUrl, jobId) : null;
    const { text, whole } = await logToCopy(url, excerpt, forgeName);
    const result = await copyLog(text, {
      clipboard: navigator.clipboard,
      select() {
        // The check's own excerpt, which is selected when the clipboard refuses.
        const el = button?.parentElement?.querySelector(
          ".pipeline-check-excerpt",
        );
        if (!el) return false;
        const range = document.createRange();
        range.selectNodeContents(el);
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
    busy = false;
    status =
      result !== "copied"
        ? "Couldn't copy automatically. The excerpt is selected: press Ctrl+C."
        : whole
          ? "Copied"
          : "Copied the excerpt (the full log could not be read)";
  }
</script>

<button
  bind:this={button}
  type="button"
  class="pipeline-check-link pipeline-check-copy"
  disabled={busy}
  onclick={copy}
  aria-label="Copy log: {name}">Copy log</button
>
<span class="pipeline-check-copy-status" role="status">{status}</span>

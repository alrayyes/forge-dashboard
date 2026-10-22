<script lang="ts">
  // A failed check's log excerpt with its Copy log button. One click copies the
  // whole log from the log endpoint, or the excerpt when the whole log can't be
  // read, and the status says which landed. Text only: nothing here is parsed
  // as markup.
  import { onDestroy } from "svelte";
  import { copyPending, copyStatus, logToCopy, logUrl } from "#lib/run-log.js";

  let {
    name,
    jobId,
    checksUrl,
    excerpt,
    forgeName,
    copyable,
  }: {
    name: string;
    jobId?: number;
    checksUrl: string;
    excerpt: string;
    forgeName: string;
    // Only a failed check has a log worth copying.
    copyable: boolean;
  } = $props();

  let status = $state("");
  let busy = $state(false);
  let pre = $state<HTMLPreElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function say(text: string) {
    status = text;
    clearTimeout(timer);
    // A line from a copy goes stale; the check may have changed since.
    timer = setTimeout(() => (status = ""), 10000);
  }

  onDestroy(() => clearTimeout(timer));

  // Copies `text` through the page selection, in a field of its own so the
  // whole text lands whatever the excerpt on screen holds.
  function selectCopy(text: string): boolean {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(field);
    field.select();
    let done = false;
    try {
      done = document.execCommand("copy");
    } catch {
      done = false;
    }
    field.remove();
    if (!done && pre) {
      // Leave the excerpt selected for the person to copy by hand.
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    return done;
  }

  async function copy() {
    if (busy) return;
    busy = true;
    say("Copying");
    // The clipboard write starts here, inside the click, with the log still
    // being read.
    const pending = logToCopy(
      jobId ? logUrl(checksUrl, jobId) : null,
      excerpt,
      forgeName,
    );
    const { outcome, prepared } = await copyPending(pending, {
      clipboard: navigator.clipboard,
      makeItem:
        typeof ClipboardItem === "undefined"
          ? undefined
          : (text) =>
              new ClipboardItem({
                "text/plain": text.then(
                  (t) => new Blob([t], { type: "text/plain" }),
                ),
              }),
      select: selectCopy,
    });
    busy = false;
    say(copyStatus(outcome, prepared, forgeName));
  }
</script>

<!-- It scrolls, so it takes focus to be reachable from the keyboard. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<pre
  bind:this={pre}
  class="pipeline-check-excerpt"
  tabindex="0"
  aria-label="Log excerpt: {name}">{excerpt}</pre>
{#if copyable}
  <div class="pipeline-check-copy">
    <button
      type="button"
      class="pipeline-check-link"
      aria-disabled={busy}
      aria-busy={busy}
      onclick={copy}
      aria-label="Copy log: {name}">Copy log</button
    >
    <span class="pipeline-check-copy-status" role="status">{status}</span>
  </div>
{/if}

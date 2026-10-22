<script lang="ts">
  // A failed check's log excerpt with its Copy log button. One click copies the
  // whole log from the log endpoint, or the excerpt when the whole log can't be
  // read, and the status says which landed. Text only: nothing here is parsed
  // as markup.
  import { onDestroy, tick } from "svelte";
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
    // Only a failed check with something to copy shows the button.
    copyable: boolean;
  } = $props();

  // The line a copy earns. "Copying" is not stored: it is shown while busy.
  let status = $state("");
  let busy = $state(false);
  // The text to copy by hand, in a field of its own, when the browser refused
  // every other way.
  let manual = $state("");
  let manualField = $state<HTMLTextAreaElement>();
  let button = $state<HTMLButtonElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;

  // A "Copied" line goes stale after a while; the check may have changed since.
  // An instruction for copying by hand stays until the next copy, since the
  // person may need longer to follow it.
  function say(text: string, stale: boolean) {
    clearTimeout(timer);
    status = text;
    if (stale) timer = setTimeout(() => (status = ""), 10000);
  }

  onDestroy(() => {
    gone = true;
    clearTimeout(timer);
  });

  // Copies `text` through the page selection, in a field of its own so the
  // whole text lands whatever the excerpt on screen holds. `host` is the modal
  // dialog the button sat in when it was clicked: the page outside it is
  // inert, and an inert field can't be copied from.
  function selectCopy(text: string, host: HTMLElement): boolean {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    host.append(field);
    // Selecting the field would take focus from the button; give it back.
    const focused = document.activeElement;
    field.select();
    // iOS Safari ignores select() on a readonly field.
    field.setSelectionRange(0, text.length);
    let done = false;
    try {
      done = document.execCommand("copy");
    } catch {
      done = false;
    }
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });

    return done;
  }

  async function copy() {
    if (busy) return;
    const host = button?.closest("dialog") ?? document.body;
    busy = true;
    manual = "";
    clearTimeout(timer);
    status = "";
    let said = "Couldn't copy the log.";
    let stale = false;
    try {
      // The clipboard write starts here, inside the click, with the log still
      // being read.
      const pending = logToCopy(
        jobId ? logUrl(checksUrl, jobId) : null,
        excerpt,
        forgeName,
        fetch,
        jobId
          ? "Couldn't tell which repository this check belongs to."
          : undefined,
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
        select: (text) => selectCopy(text, host),
      });
      said = copyStatus(outcome, prepared, forgeName);
      stale = outcome === "copied";
      if (outcome === "selected") manual = prepared.text;
    } catch {
      // keep the generic line
    } finally {
      // A removed row has no status left to show; there is nothing to announce.
      if (!gone) {
        busy = false;
        say(said, stale);
      }
    }
    if (manual && !gone) {
      await tick();
      manualField?.focus();
      manualField?.select();
      manualField?.setSelectionRange(0, manual.length);
    }
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
      bind:this={button}
      type="button"
      class="pipeline-check-link"
      aria-disabled={busy ? "true" : undefined}
      aria-busy={busy ? "true" : undefined}
      onclick={copy}
      aria-label="Copy log: {name}">Copy log</button
    >
    <span class="pipeline-check-copy-status" role="status"
      >{busy ? "Copying" : status}</span
    >
  </div>
{/if}
{#if manual}
  <textarea
    bind:this={manualField}
    class="pipeline-check-manual"
    readonly
    rows="6"
    aria-label="Log to copy: {name}">{manual}</textarea
  >
{/if}

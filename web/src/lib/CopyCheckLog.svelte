<script lang="ts">
  // A failed check's log excerpt with its Copy log button. One click copies the
  // whole log from the log endpoint, or the excerpt when the whole log can't be
  // read, and the status says which landed. Text only: nothing here is parsed
  // as markup.
  import { onDestroy, tick } from "svelte";
  import {
    copyPending,
    copyStatus,
    logSource,
    logToCopy,
  } from "#lib/run-log.js";

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

  // The row is keyed by the check's name, so a rerun hands the same component a
  // new job and excerpt. What was copied or shown for the old one must not stay
  // for the new one: someone could paste a stale log into a ticket.
  let generation = 0;
  let identity: string | undefined;
  $effect.pre(() => {
    const next = `${jobId ?? ""}\u0000${excerpt}`;
    if (identity !== undefined && next !== identity) {
      generation++;
      clearTimeout(timer);
      manual = "";
      status = "";
      busy = false;
    }
    identity = next;
  });

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
    const run = generation;
    busy = true;
    clearTimeout(timer);
    status = "";
    let said = "Couldn't copy the log.";
    let stale = false;
    try {
      // The clipboard write starts here, inside the click, with the log still
      // being read.
      const source = logSource(checksUrl, jobId);
      // A check rerun (or its row gone) while the log loads has another log
      // now: the read fails then, so the clipboard write that waits on it
      // writes nothing rather than the old run's log.
      const pending = logToCopy(
        source.url,
        excerpt,
        forgeName,
        fetch,
        source.why,
      ).then((prepared) => {
        if (run !== generation || gone) throw new Error("the check was rerun");

        return prepared;
      });
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
      // The check was rerun meanwhile: this log is not its log any more.
      if (run !== generation) return;
      said = copyStatus(outcome, prepared, forgeName);
      stale = outcome === "copied";
      // The field from an earlier press stays until there is a new result, so
      // pressing the button again never takes away what the person is copying.
      manual = outcome === "selected" ? prepared.text : "";
    } catch {
      // keep the generic line, and drop a field left by an earlier press: it
      // holds a log this press did not produce
      manual = "";
    } finally {
      // A removed row has no status left to show; there is nothing to announce.
      if (!gone && run === generation) {
        busy = false;
        say(said, stale);
      }
    }
    if (manual && !gone && run === generation) {
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

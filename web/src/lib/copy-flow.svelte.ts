// The copy flow behind the pipeline dialog's two Copy buttons: the clipboard
// write, the selection fallback, the field to copy from by hand, and the one
// status line that says truthfully which of these happened. The buttons differ
// only in where the text comes from, so they hand that in as `prepare`.
import { tick } from 'svelte';
import { copyPending, copyStatus, type Prepared } from '#lib/run-log.js';

// Copies `text` through the page selection, in a field of its own so the
// whole text lands whatever is on screen. `host` is the modal
// dialog the button sat in when it was clicked: the page outside it is
// inert, and an inert field can't be copied from.
function selectCopy(text: string, host: HTMLElement): boolean {
  // A dialog closed while the log loaded has nobody to copy for.
  if (host instanceof HTMLDialogElement && !host.open) return false;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  host.append(field);
  // Selecting the field would take focus from the button; give it back.
  const focused = document.activeElement;
  let done = false;
  try {
    field.select();
    // iOS Safari ignores select() on a readonly field.
    field.setSelectionRange(0, text.length);
    done = document.execCommand('copy');
  } catch {
    done = false;
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) {
      focused.focus({ preventScroll: true });
    }
  }

  return done;
}

export class CopyFlow {
  // The line a copy earns. "Copying" is not stored: it is shown while busy.
  status = $state('');
  busy = $state(false);
  // The text to copy by hand, in a field of its own, when the browser refused
  // every other way.
  manual = $state('');
  field = $state<HTMLTextAreaElement>();
  button = $state<HTMLButtonElement>();

  #generation = 0;
  #gone = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #forgeName: () => string;

  readonly #noun: string;

  // `noun` is what the person is copying ("log", "output"), for the lines
  // that name it.
  constructor(forgeName: () => string, noun = 'log') {
    this.#forgeName = forgeName;
    this.#noun = noun;
  }

  // A "Copied" line goes stale after a while; the check may have changed since.
  // An instruction for copying by hand stays until the next copy, since the
  // person may need longer to follow it.
  #say(text: string, stale: boolean) {
    clearTimeout(this.#timer);
    this.status = text;
    if (stale) this.#timer = setTimeout(() => (this.status = ''), 10000);
  }

  // What was copied or shown for an earlier log must not stay for another:
  // someone could paste a stale log into a ticket. Any copy still in flight
  // is dropped when it lands.
  reset() {
    this.#generation++;
    clearTimeout(this.#timer);
    // Someone reading the field would lose their place when it goes: focus
    // would fall to the page. Hand it to the button, which stays.
    if (this.field && document.activeElement === this.field) {
      this.button?.focus({ preventScroll: true });
    }
    this.manual = '';
    this.status = '';
    this.busy = false;
  }

  destroy() {
    this.#gone = true;
    clearTimeout(this.#timer);
  }

  // `prepare` yields the text to copy. It runs inside the click, and is handed
  // a `guard` to call once the text is known: it throws when the copy no
  // longer has anybody to copy for (the log changed, the row went, the dialog
  // closed), so the clipboard write that waits on it writes nothing.
  async copy(prepare: (guard: () => void) => Promise<Prepared>) {
    if (this.busy) return;
    const button = this.button;
    // The field is copied from inside the modal dialog (the page outside it is
    // inert); outside one, from beside the button.
    const host =
      button?.closest('dialog') ?? button?.parentElement ?? document.body;
    const run = this.#generation;
    const forgeName = this.#forgeName();
    this.busy = true;
    clearTimeout(this.#timer);
    this.status = '';
    let said = `Couldn't copy the ${this.#noun}.`;
    let stale = false;
    try {
      const pending = prepare(() => {
        if (run !== this.#generation || this.#gone) {
          throw new Error('the check was rerun');
        }
        // A dialog closed while the log loaded has nobody to copy for, on the
        // clipboard item's path as much as the selection's.
        if (host instanceof HTMLDialogElement && !host.open) {
          throw new Error('the dialog was closed');
        }
      });
      const { outcome, prepared } = await copyPending(pending, {
        clipboard: navigator.clipboard,
        makeItem:
          typeof ClipboardItem === 'undefined'
            ? undefined
            : (text) =>
                new ClipboardItem({
                  'text/plain': text.then(
                    (t) => new Blob([t], { type: 'text/plain' }),
                  ),
                }),
        select: (text) => selectCopy(text, host),
      });
      // The log changed meanwhile: this log is not its log any more.
      if (run !== this.#generation) return;
      said = copyStatus(outcome, prepared, forgeName, this.#noun);
      stale = outcome === 'copied';
      // The field from an earlier press stays until there is a new result, so
      // pressing the button again never takes away what the person is copying.
      this.manual = outcome === 'selected' ? prepared.text : '';
    } catch {
      // keep the generic line, and drop a field left by an earlier press: it
      // holds a log this press did not produce
      if (run === this.#generation) this.manual = '';
    } finally {
      // A removed row has no status left to show; there is nothing to announce.
      if (!this.#gone && run === this.#generation) {
        this.busy = false;
        this.#say(said, stale);
      }
    }
    if (this.manual && !this.#gone && run === this.#generation) {
      await tick();
      this.field?.focus();
      this.field?.select();
      this.field?.setSelectionRange(0, this.manual.length);
    }
  }
}

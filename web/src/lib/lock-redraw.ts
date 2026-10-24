// Tells an open dialog when the forge locks its control reads have changed, so
// it redraws once per change and not on every snapshot. The key it compares
// is written here, at the decision, and not by the control: a control that
// draws nothing (a pull request with no rerun action) never writes one.
export class LockRedraw {
  private last: string | null = null;

  // A control drew under key.
  drawn(key: string): void {
    this.last = key;
  }

  // Whether key differs from the last one seen, remembering it. The first key
  // after a reset is only noted: nothing was drawn under another one.
  changed(key: string): boolean {
    const was = this.last;
    this.last = key;
    return was !== null && was !== key;
  }

  // Forgets the last key, for the next dialog.
  reset(): void {
    this.last = null;
  }
}

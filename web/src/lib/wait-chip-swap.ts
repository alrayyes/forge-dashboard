// Logic for the shared armed-wait / Update branch slot (#4942), drawn by
// wait-chip.ts. The slot is one button: it shows the wait, and shows
// Update branch while "revealed" (mouse hover, keyboard focus or a first tap).

export type TapOutcome = 'run' | 'reveal' | 'explain';

// What activating the button does. `detail` is the click event's count: 0 for
// Enter, Space and a screen reader's click, so those never need a reveal
// first (#4531: hover is never the only way). A mouse click lands on a chip
// hover already revealed. Only a first touch tap, which has no hover,
// reveals before it runs, so a stray tap can't start an update.
export function tapOutcome(input: {
  revealed: boolean;
  detail: number;
  locked: boolean;
}): TapOutcome {
  if (input.locked) return 'explain';
  if (input.detail === 0 || input.revealed) return 'run';
  return 'reveal';
}

// The words drawn in the slot. The accessible name is swapName's, which holds
// both labels; this is only what a sighted user reads.
export function swapLabel(input: {
  revealed: boolean;
  inFlight: boolean;
}): string {
  if (input.inFlight) return 'Updating branch…';
  return input.revealed ? 'Update branch' : 'Waiting for CI';
}

export type SwapPhase = 'idle' | 'locked' | 'inflight';

// The slot's second line. The chip's own line shows until the swap is
// revealed; then it says what comes next, or why Update branch is locked.
export function swapDetail(input: {
  phase: SwapPhase;
  revealed: boolean;
  idleDetail: string;
  reason: string;
}): string {
  if (input.phase === 'inflight') return 'Auto-merge follows when it lands';
  if (!input.revealed) return input.idleDetail;
  return input.phase === 'locked' ? input.reason : 'Then auto-merge goes on';
}

// What the swap needs of the cell updateBranchActionCell returns: the bare
// button on the idle path, or a span around a locked or retry button.
type CellLike = {
  tagName: string;
  querySelector(selector: string): SourceLike | null;
};
export type SourceLike = {
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  click(): void;
};

// The real Update branch button the swap proxies to, or undefined where the
// row should keep its plain button. A retryable lock is a Retry button with no
// aria-disabled: the chip would read it as idle and run the retry with the
// reason hidden, so it gets no swap.
export function swapSourceOf(
  cell: (CellLike & SourceLike) | null | undefined,
): SourceLike | undefined {
  if (!cell) return undefined;
  const button =
    cell.tagName === 'BUTTON' ? cell : cell.querySelector('button');
  if (!button) return undefined;
  if (
    button.textContent === 'Retry' &&
    button.getAttribute('aria-disabled') !== 'true'
  )
    return undefined;
  return button;
}

// Where Update branch stands, from the real button and whether this chip ran
// it. Not read from the button's words.
export function swapPhaseOf(input: {
  disabled: boolean;
  ran: boolean;
}): SwapPhase {
  if (!input.disabled) return 'idle';
  return input.ran ? 'inflight' : 'locked';
}

// The one accessible name. It holds both visible labels (WCAG 2.5.3); in
// flight it says updating, which is the visible word then.
export function swapName(phase: SwapPhase): string {
  return phase === 'inflight'
    ? 'Waiting for CI, updating branch'
    : 'Waiting for CI, update branch';
}

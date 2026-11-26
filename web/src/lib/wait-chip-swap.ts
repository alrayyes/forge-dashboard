// Mockup logic for the shared armed-wait / Update branch slot (#4942). Not
// wired into the row. The slot is one button: it shows the wait, and shows
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

// The words drawn in the slot. The accessible name stays "Update branch" in
// every state; this is only what a sighted user reads.
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

// The one accessible name. It holds both visible labels (WCAG 2.5.3); in
// flight it says updating, which is the visible word then.
export function swapName(phase: SwapPhase): string {
  return phase === 'inflight'
    ? 'Waiting for CI, updating branch'
    : 'Waiting for CI, update branch';
}

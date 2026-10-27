// Fixture shorthand: the status and conclusion the server sends for a check
// that reads as `state` on the page (queued, running, awaiting_approval, or a
// conclusion). Lets a spec that loops over states keep its table readable.
export function factsOf(state: string): {
  status: string;
  conclusion?: string;
} {
  if (state === 'queued') return { status: 'queued' };
  if (state === 'running') return { status: 'in_progress' };
  if (state === 'awaiting_approval') return { status: 'waiting' };

  return { status: 'completed', conclusion: state };
}

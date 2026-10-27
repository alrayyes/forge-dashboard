// Test fixture shorthand: the status and conclusion the server sends for a
// check the page reads as `state` (the vocabulary of checkState). Not used by
// the app.
export function factsOf(state: string): {
  status: string;
  conclusion?: string;
} {
  if (state === 'queued') return { status: 'queued' };
  if (state === 'running') return { status: 'in_progress' };
  if (state === 'awaiting_approval') return { status: 'waiting' };

  return { status: 'completed', conclusion: state };
}

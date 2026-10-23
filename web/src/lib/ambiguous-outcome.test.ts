/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readAmbiguousOutcome } from './ambiguous-outcome';

// A request that rejects with no status never says whether the server acted:
// the connection can drop after the write landed. The page asks the server
// what the pull request looks like now instead of trusting the rejection.
// https://github.com/alrayyes/forge-dashboard/issues/2628

type Snap = { pullRequests: { id: string; behind: boolean }[] };

describe('readAmbiguousOutcome', () => {
  test('says the action ran when the fresh snapshot shows its effect', async () => {
    const snap: Snap = { pullRequests: [{ id: 'a', behind: false }] };
    const r = await readAmbiguousOutcome(
      async () => snap,
      (s) => !s.pullRequests.some((p) => p.behind),
    );
    expect(r).toEqual({ ran: true, data: snap });
  });

  test('says it did not run when the snapshot shows nothing changed', async () => {
    const snap: Snap = { pullRequests: [{ id: 'a', behind: true }] };
    const r = await readAmbiguousOutcome(
      async () => snap,
      (s) => !s.pullRequests.some((p) => p.behind),
    );
    expect(r).toEqual({ ran: false, data: snap });
  });

  test('says it did not run when the refresh fails too', async () => {
    const r = await readAmbiguousOutcome<Snap>(
      async () => {
        throw new TypeError('Failed to fetch');
      },
      () => true,
    );
    expect(r).toEqual({ ran: false, data: null });
  });

  test('treats an empty refresh answer as not run', async () => {
    const r = await readAmbiguousOutcome<Snap>(
      async () => null,
      () => true,
    );
    expect(r).toEqual({ ran: false, data: null });
  });
});

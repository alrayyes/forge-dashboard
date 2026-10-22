// "Rerun failed checks" in the Main branches pipeline dialog: the branch twin of
// the pull request board's button, drawn into the dialog's controls slot. The
// request is one POST naming the repository; the forge queues the failed jobs
// and the next refresh carries their result.

import {
  type ActionRequestError,
  failureDetails,
  readActionFailure,
} from './action-error';
import { copyButton } from './copy-details';
import type { FailureDetails } from './feedback';

// How long a queued rerun is held, so the same rerun can't be queued twice.
const HOLD_MS = 10 * 60 * 1000;

type State =
  | { phase: 'requesting' }
  | { phase: 'queued'; queuedAt: number; signature: string }
  | { phase: 'failed'; message: string; details: FailureDetails };

export type RerunTarget = { forge: string; fullName: string };

export function createBranchRerun() {
  const states = new Map<string, State>();
  // The controls on screen per repository. The dialog draws its control again
  // when the checks change, so the node a click came from may be gone by the
  // time the request ends: the answer goes to whichever nodes are on screen.
  const views = new Map<string, Set<{ node: HTMLElement; sync: () => void }>>();
  const keyOf = (t: RerunTarget) => `${t.forge}\u0000${t.fullName}`;

  // A queued rerun is held until the branch's CI moves on or the hold runs out.
  const held = (t: RerunTarget, signature: string) => {
    const s = states.get(keyOf(t));
    return (
      s?.phase === 'queued' &&
      s.signature === signature &&
      Date.now() - s.queuedAt <= HOLD_MS
    );
  };

  // Redraws every control on screen for key, and forgets the ones that left it.
  function syncAll(key: string) {
    const live = views.get(key);
    if (!live) return;
    for (const view of live) {
      if (!view.node.isConnected) live.delete(view);
      else view.sync();
    }
    if (live.size === 0) views.delete(key);
  }

  async function post(t: RerunTarget): Promise<void> {
    const res = await fetch('/api/main-branches/rerun-checks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ forge: t.forge, fullName: t.fullName }),
    });
    if (res.status === 401) {
      window.location.href = '/login.html';
      throw new Error('session expired');
    }
    if (res.status === 204) return;
    throw await readActionFailure(res);
  }

  // The control to draw above the list. `signature` is the row's CI signature,
  // read again by the caller for each draw.
  function control(t: RerunTarget, signature: () => string): HTMLElement {
    const key = keyOf(t);
    const wrap = document.createElement('div');
    wrap.className = 'pipeline-rerun';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row-action';
    const status = document.createElement('p');
    status.className = 'pipeline-rerun-status';
    status.setAttribute('role', 'status');
    const failureBox = document.createElement('div');
    failureBox.className = 'pipeline-rerun-failure';
    const failure = document.createElement('p');
    failure.className = 'pipeline-error';
    failure.setAttribute('role', 'alert');
    failureBox.appendChild(failure);

    const sync = () => {
      const isHeld = held(t, signature());
      const state = states.get(key);
      const sending = state?.phase === 'requesting';
      button.textContent = isHeld ? 'Rerun queued' : 'Rerun failed checks';
      // Pending, not disabled, so the button keeps focus.
      if (isHeld || sending) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
      status.textContent = isHeld
        ? 'Rerun queued. The new results show here after the next refresh.'
        : sending
          ? 'Queuing the rerun…'
          : '';
      for (const extra of failureBox.querySelectorAll(
        '.pipeline-rerun-copy, .feedback-details',
      ))
        extra.remove();
      if (state?.phase === 'failed') {
        failure.textContent = state.message;
        failureBox.hidden = false;
        failureBox.appendChild(
          copyButton(state.details, 'row-action pipeline-rerun-copy'),
        );
      } else {
        failureBox.hidden = true;
        failure.textContent = '';
      }
    };
    sync();
    const view = { node: wrap, sync };
    const live = views.get(key) ?? new Set();
    views.set(key, live);
    live.add(view);

    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      const sig = signature();
      states.set(key, { phase: 'requesting' });
      syncAll(key);
      post(t)
        .then(() => {
          states.set(key, {
            phase: 'queued',
            queuedAt: Date.now(),
            signature: sig,
          });
        })
        .catch((err: ActionRequestError) => {
          states.set(key, {
            phase: 'failed',
            message: err.message,
            details: failureDetails(err, {
              action: 'rerun-checks',
              forge: t.forge,
              repo: t.fullName,
            }),
          });
        })
        .finally(() => syncAll(key));
    });

    wrap.append(button, status, failureBox);
    return wrap;
  }

  return { control };
}

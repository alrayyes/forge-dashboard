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
import type { ForgeLock } from './forge-lock';
import { msUntilReset } from './rate-limit';

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
  // One timer per repository, set when a rerun is queued so the control redraws
  // when the hold ends even if nothing else does.
  const releases = new Map<string, ReturnType<typeof setTimeout>>();
  // One timer per repository while its forge's rate limit holds the control
  // back, so the button returns when the limit lifts even with no poll.
  const unlocks = new Map<
    string,
    { at: string; timer: ReturnType<typeof setTimeout> }
  >();
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
    if (live.size === 0) {
      views.delete(key);
      // No control is left to redraw, so the hold's timer has nothing to do.
      clearTimeout(releases.get(key));
      releases.delete(key);
      clearTimeout(unlocks.get(key)?.timer);
      unlocks.delete(key);
    }
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

  // The control to draw above the list. `signature` is the row's CI signature
  // and `lock` is why the forge would refuse a rerun, both read again by the
  // caller for each draw.
  function control(
    t: RerunTarget,
    signature: () => string,
    lock: () => ForgeLock | null = () => null,
  ): HTMLElement {
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

    let shownFailure: unknown = null;
    const sync = () => {
      const isHeld = held(t, signature());
      // A forge that can't be reached or has no budget left would refuse the
      // click, so there is no button, only the reason.
      const locked = lock();
      // A refusal from before the lock is stale once the lock lifts.
      if (locked && states.get(key)?.phase === 'failed') states.delete(key);
      const state = states.get(key);
      const sending = state?.phase === 'requesting';
      if (locked) {
        // Take keyboard focus along, or it drops to the page.
        if (document.activeElement === button) {
          wrap.tabIndex = -1;
          wrap.focus();
        }
        button.remove();
      } else if (!button.isConnected) wrap.prepend(button);
      button.textContent = isHeld ? 'Rerun queued' : 'Rerun failed checks';
      // Pending, not disabled, so the button keeps focus.
      if (isHeld || sending) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
      // The lock adds to what the status already says; it never replaces it.
      const text = [
        isHeld
          ? 'Rerun queued. The new results show here after the next refresh.'
          : sending
            ? 'Queuing the rerun…'
            : '',
        locked?.reason ?? '',
      ]
        .filter(Boolean)
        .join(' ');
      // A live region: write only a change, or each redraw re-announces it.
      if (status.textContent !== text) status.textContent = text;
      // Armed once per reset time, so a redraw does not restart it.
      const at = locked?.resetsAt;
      if (unlocks.get(key)?.at !== at) {
        clearTimeout(unlocks.get(key)?.timer);
        unlocks.delete(key);
        const wait = at ? msUntilReset(at) : null;
        if (at && wait !== null)
          unlocks.set(key, {
            at,
            timer: setTimeout(() => {
              unlocks.delete(key);
              syncAll(key);
            }, wait),
          });
      }
      // Drawn once per failure, so a redraw keeps the Copy button's focus and
      // its "Copied" feedback.
      const failed = state?.phase === 'failed' ? state : null;
      if (failed !== shownFailure) {
        shownFailure = failed;
        for (const extra of failureBox.querySelectorAll(
          '.pipeline-rerun-copy, .feedback-details',
        ))
          extra.remove();
        if (failed) {
          failure.textContent = failed.message;
          failureBox.hidden = false;
          failureBox.appendChild(
            copyButton(failed.details, 'row-action pipeline-rerun-copy'),
          );
        } else {
          failureBox.hidden = true;
          failure.textContent = '';
        }
      }
    };
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
          clearTimeout(releases.get(key));
          releases.set(
            key,
            // One past the hold, which `held` still counts as held at HOLD_MS.
            setTimeout(() => syncAll(key), HOLD_MS + 1),
          );
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

    wrap.append(status, failureBox);
    sync();
    return wrap;
  }

  // Draws the controls for t again, when something outside them changed.
  const redraw = (t: RerunTarget) => syncAll(keyOf(t));

  return { control, redraw };
}

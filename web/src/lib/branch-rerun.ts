// "Rerun failed checks" in the Main branches pipeline dialog: the branch twin of
// the pull request board's button, drawn into the dialog's controls slot. The
// request is one POST naming the repository; the forge queues the failed jobs
// and the next refresh carries their result.

import {
  type ActionRequestError,
  failureDetails,
  isTransientFailure,
  readActionFailure,
} from './action-error';
import { copyButton } from './copy-details';
import type { FailureDetails } from './feedback';
import { type ForgeLock, rerunScopeNote } from './forge-lock';
import { msUntilReset } from './rate-limit';

// How long a queued rerun is held, so the same rerun can't be queued twice.
const HOLD_MS = 10 * 60 * 1000;

type State =
  | { phase: 'requesting' }
  | { phase: 'queued'; queuedAt: number; signature: string }
  | {
      phase: 'failed';
      message: string;
      details: FailureDetails;
      // An outage or a spent rate limit passes, and the line about it is stale
      // once a lock has come and gone. A refusal (a missing permission, say)
      // is still true after one, so it stays until the next attempt.
      passes: boolean;
    };

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
  const MAX_UNLOCK_WAIT_MS = 5 * 60 * 1000;
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
    const scope = rerunScopeNote(t.forge);
    if (scope) button.title = scope;
    const status = document.createElement('p');
    status.className = 'pipeline-rerun-status';
    status.setAttribute('role', 'status');
    const failureBox = document.createElement('div');
    failureBox.className = 'pipeline-rerun-failure';
    const failure = document.createElement('p');
    failure.className = 'pipeline-error';
    failure.setAttribute('role', 'alert');
    failureBox.appendChild(failure);

    // Keep keyboard focus in the control when the element holding it goes: on
    // the button if it is on screen, else on the wrapper, which leaves the tab
    // order again as soon as focus moves on.
    const keepFocus = () => {
      if (button.isConnected) {
        button.focus();
        return;
      }
      wrap.tabIndex = -1;
      wrap.addEventListener('blur', () => wrap.removeAttribute('tabindex'), {
        once: true,
      });
      wrap.focus();
    };

    let shownFailure: unknown = null;
    const sync = () => {
      const isHeld = held(t, signature());
      // A forge that can't be reached or has no budget left would refuse the
      // click, so there is no button, only the reason.
      const locked = lock();
      // Deliberate, though it writes from a draw: an outage or rate-limit
      // failure from before the lock is stale once the lock lifts, for every
      // view of this repository.
      const before = states.get(key);
      if (locked && before?.phase === 'failed' && before.passes)
        states.delete(key);
      const state = states.get(key);
      const sending = state?.phase === 'requesting';
      if (locked) {
        // Take keyboard focus along, or it drops to the page.
        const hadFocus = document.activeElement === button;
        button.remove();
        if (hadFocus) keepFocus();
      } else if (!button.isConnected) {
        wrap.prepend(button);
        // Focus was parked on the wrapper while the button was away.
        if (document.activeElement === wrap) button.focus();
        wrap.removeAttribute('tabindex');
      }
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
      // Armed once per reset time, so a redraw does not restart it. Only a
      // rate limit says when it ends; an unreachable forge is looked at again
      // by the next poll's redraw.
      const at = locked?.resetsAt;
      if (unlocks.get(key)?.at !== at) {
        clearTimeout(unlocks.get(key)?.timer);
        unlocks.delete(key);
        // setTimeout wraps past about 24 days and would fire at once, looping;
        // the next poll arms it again anyway.
        const left = at ? msUntilReset(at) : null;
        // A reset that passed since the lock was computed: look again shortly.
        const wait = Math.min(left ?? 250, MAX_UNLOCK_WAIT_MS);
        if (at)
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
        // Focus on the Copy button would drop to the page when it goes.
        const focused = document.activeElement;
        if (
          focused instanceof HTMLElement &&
          failureBox.contains(focused) &&
          focused !== failure
        )
          keepFocus();
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
      // A snapshot may have locked the forge since the last draw.
      if (lock()) return sync();
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
            passes: isTransientFailure(err) || err.code === 'rate_limited',
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

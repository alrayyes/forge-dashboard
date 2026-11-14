// Which control marks which saved key as touched. Marking is what keeps a saved
// copy that is still loading from overwriting a change made meanwhile (#1713),
// and nothing else says which control must do it. The Insights and Webhooks
// pages call these instead of touching the keys themselves, so each is
// unit-tested. No DOM here.

import {
  type HeldPick,
  heldPicks,
  readCookieState,
  releaseHeld,
  type SharedFilterState,
  saveState,
  touchKey,
} from './filters';
import { type WebhooksFilter, webhooksFilterToState } from './webhooks-filter';

// A shared control (title, forge, repo, author, label) was changed. A pick held
// back for it is let go, since this is the user's own change.
export function setSharedControl(
  state: SharedFilterState,
  col: string,
  value: string,
): void {
  state.shared[col] = value;
  touchKey('shared', col);
  releaseHeld('shared', col);
}

export function setHideDependencyDashboard(
  state: SharedFilterState,
  hide: boolean,
): void {
  state.issue.hideDependencyDashboard = hide ? '1' : '';
  touchKey('issue', 'hideDependencyDashboard');
}

// The user dropped one saved pick this page does not offer: it is cleared, kept
// cleared over the saved copy, saved, and the picks still held are returned.
export function releaseHeldPick(
  state: SharedFilterState,
  pick: HeldPick,
): HeldPick[] {
  releaseHeld(pick.group, pick.key);
  touchKey(pick.group, pick.key);
  saveState(state);
  return heldPicks();
}

// The Webhooks filter changed. The keys are touched before the save, so a
// server copy still loading does not overwrite them (#1713). Another tab may
// have saved its own filters since this page loaded; the cookie is shared, so
// start from it and change only this page's group. Returns the state to keep.
export function saveWebhooksFilter(
  saved: SharedFilterState,
  filter: WebhooksFilter,
  keys: string[],
  freeText = false,
): SharedFilterState {
  for (const key of keys) touchKey('webhooks', key);
  let next = saved;
  if (document.cookie.includes('forge-board-filters='))
    next = { ...readCookieState(), webhooks: {} };
  next.webhooks = webhooksFilterToState(filter);
  saveState(next, freeText ? 'title' : undefined);
  return next;
}
